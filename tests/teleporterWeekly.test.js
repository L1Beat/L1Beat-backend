/**
 * Tests for the resumable weekly Teleporter update.
 *
 * Mocks the model layer so updateWeeklyData can run without a database, then:
 *  - exercises the pure helpers (mergePartialResults, getWeeklyDayWindow)
 *  - simulates a mid-run crash and verifies the next run RESUMES from the
 *    next unfetched day rather than starting over.
 */

// In-memory model mock. `store` lives inside the factory (jest.mock hoisting),
// and is exposed via __store / __reset for the test to seed and inspect.
jest.mock('../src/models/teleporterMessage', () => {
  const store = { weekly: null, saved: [] };

  const TeleporterUpdateState = {
    find: () => ({ sort: async () => (store.weekly ? [store.weekly] : []) }),
    deleteMany: async () => ({ deletedCount: 0 }),
    updateMany: async () => ({ modifiedCount: 0 }),
    updateOne: async () => ({ upsertedCount: 0 }),
    findOneAndUpdate: async () => {
      const doc = store.weekly;
      if (!doc || doc.state === 'in_progress') return null; // lock held
      doc.state = 'in_progress';
      doc.startedAt = new Date();
      doc.lastUpdatedAt = new Date();
      doc.error = null;
      return doc;
    },
    findOne: async () => store.weekly
  };

  class TeleporterMessage {
    constructor(data) { Object.assign(this, data); }
    async save() { store.saved.push(this); }
    static async deleteMany() { return { deletedCount: 0 }; }
  }

  return {
    TeleporterMessage,
    TeleporterUpdateState,
    __store: store,
    __reset: () => {
      store.saved = [];
      store.weekly = {
        updateType: 'weekly',
        state: 'idle',
        startedAt: null,
        lastUpdatedAt: new Date(),
        error: null,
        referenceEndTime: null,
        partialResults: [],
        progress: {
          currentDay: 1, totalDays: 7, daysCompleted: 0,
          currentChunk: 0, totalChunks: 6, messagesCollected: 0
        },
        async save() { /* in-place; we hold the reference */ }
      };
    }
  };
});

const teleporterService = require('../src/services/teleporterService');
const { __store, __reset } = require('../src/models/teleporterMessage');

describe('TeleporterService pure helpers', () => {
  it('getWeeklyDayWindow returns contiguous, non-overlapping 24h windows', () => {
    const anchor = 7 * 24 * 3600; // arbitrary anchor in seconds
    const day1 = teleporterService.getWeeklyDayWindow(anchor, 1);
    const day2 = teleporterService.getWeeklyDayWindow(anchor, 2);

    expect(day1.endTime).toBe(anchor);                 // day 1 ends at the anchor
    expect(day1.endTime - day1.startTime).toBe(86400); // exactly 24h
    expect(day2.endTime).toBe(day1.startTime);         // contiguous, no gap/overlap
  });

  it('mergePartialResults sums counts per chain pair and totals messages', () => {
    const merged = teleporterService.mergePartialResults([
      { totalMessages: 3, messageCount: [
        { sourceChain: 'A', destinationChain: 'B', messageCount: 2 },
        { sourceChain: 'C', destinationChain: 'D', messageCount: 1 }
      ] },
      { totalMessages: 5, messageCount: [
        { sourceChain: 'A', destinationChain: 'B', messageCount: 5 }
      ] }
    ]);

    expect(merged.totalMessages).toBe(8);
    // A|B summed across days (2 + 5 = 7) and sorted first by count desc.
    expect(merged.messageCounts).toEqual([
      { sourceChain: 'A', destinationChain: 'B', messageCount: 7 },
      { sourceChain: 'C', destinationChain: 'D', messageCount: 1 }
    ]);
  });
});

describe('TeleporterService resumable weekly update', () => {
  let fetchSpy;
  let crashArmed;

  beforeEach(() => {
    __reset();
    crashArmed = true;

    // processMessages → one chain pair whose count is the day's message volume.
    jest.spyOn(teleporterService, 'processMessages').mockImplementation(async (msgs) => (
      [{ sourceChain: 'A', destinationChain: 'B', messageCount: msgs.length }]
    ));

    // Each day returns (day * 10) messages. Day is inferred from how many days
    // are already completed. Crash once, when about to fetch day 4.
    fetchSpy = jest.spyOn(teleporterService, 'fetchICMMessagesInWindow').mockImplementation(async () => {
      const dayBeingFetched = __store.weekly.progress.daysCompleted + 1;
      if (crashArmed && dayBeingFetched === 4) {
        throw new Error('simulated crash mid-update');
      }
      return new Array(dayBeingFetched * 10).fill({});
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('checkpoints each day and resumes from the crash point without refetching', async () => {
    // First run crashes while fetching day 4.
    await expect(teleporterService.updateWeeklyData()).rejects.toThrow('simulated crash');

    // Days 1-3 are checkpointed; state is failed but progress is preserved.
    expect(__store.weekly.state).toBe('failed');
    expect(__store.weekly.progress.daysCompleted).toBe(3);
    expect(__store.weekly.partialResults).toHaveLength(3);
    expect(__store.weekly.referenceEndTime).toBeTruthy();
    // 4 calls: days 1-3 succeeded, the day-4 call threw.
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // Second run resumes (no crash this time).
    crashArmed = false;
    const result = await teleporterService.updateWeeklyData();

    expect(result.success).toBe(true);
    // Resume re-fetches only days 4-7 (4 more) → 8 total. A fresh restart would
    // have re-fetched days 1-7 (7 more) for 11 total, so 8 proves days 1-3 were
    // not refetched.
    expect(fetchSpy).toHaveBeenCalledTimes(8);

    // Final merged total = 10+20+...+70 = 280, all into the single A|B pair.
    expect(result.totalMessages).toBe(280);
    expect(result.messageCount).toBe(1);

    const savedWeekly = __store.saved.find(d => d.dataType === 'weekly');
    expect(savedWeekly).toBeTruthy();
    expect(savedWeekly.totalMessages).toBe(280);
    expect(savedWeekly.messageCounts).toEqual([
      { sourceChain: 'A', destinationChain: 'B', messageCount: 280 }
    ]);

    // Completion clears the resume checkpoint.
    expect(__store.weekly.state).toBe('completed');
    expect(__store.weekly.partialResults).toHaveLength(0);
    expect(__store.weekly.referenceEndTime).toBeNull();
  });
});
