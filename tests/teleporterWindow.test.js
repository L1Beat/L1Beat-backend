/**
 * Regression test for the weekly day-window boundary fix.
 *
 * Adjacent day-windows share a boundary timestamp (day N's startTime equals
 * day N+1's endTime). The per-message filter uses a half-open interval
 * [startTime, endTime), so a message landing exactly on the shared boundary
 * must be counted in exactly ONE window — never both (which would double-count
 * it after mergePartialResults).
 */

jest.mock('axios');
const axios = require('axios');
const teleporterService = require('../src/services/teleporterService');

const ANCHOR = 1_000_000_000; // seconds (< 1e12 so no ms conversion)
const DAY = 24 * 60 * 60;

const messages = [
  { id: 'a', sourceTransaction: { timestamp: ANCHOR - DAY / 2 } },        // inside day 1
  { id: 'boundary', sourceTransaction: { timestamp: ANCHOR - DAY } },     // the shared boundary
  { id: 'b', sourceTransaction: { timestamp: ANCHOR - DAY - DAY / 2 } }   // inside day 2
];

describe('fetchICMMessagesInWindow boundary handling', () => {
  beforeEach(() => {
    teleporterService.GLACIER_API_BASE = 'http://glacier.test';
    // Same full page returned for every call; the client-side filter decides
    // which messages belong to the requested window.
    axios.get.mockResolvedValue({ data: { messages, nextPageToken: null } });
  });

  afterEach(() => jest.restoreAllMocks());

  it('assigns a boundary-timestamp message to exactly one of two adjacent windows', async () => {
    const day1 = teleporterService.getWeeklyDayWindow(ANCHOR, 1); // [ANCHOR-DAY, ANCHOR)
    const day2 = teleporterService.getWeeklyDayWindow(ANCHOR, 2); // [ANCHOR-2DAY, ANCHOR-DAY)

    // Sanity: the windows share a boundary.
    expect(day1.startTime).toBe(day2.endTime);

    const day1Msgs = await teleporterService.fetchICMMessagesInWindow(day1.startTime, day1.endTime, 'weekly');
    const day2Msgs = await teleporterService.fetchICMMessagesInWindow(day2.startTime, day2.endTime, 'weekly');

    const ids1 = day1Msgs.map(m => m.id).sort();
    const ids2 = day2Msgs.map(m => m.id).sort();

    // Boundary message belongs to day 1 (startTime is inclusive), not day 2
    // (endTime is exclusive) — counted exactly once across the two windows.
    expect(ids1).toEqual(['a', 'boundary']);
    expect(ids2).toEqual(['b']);
    expect(ids1).toContain('boundary');
    expect(ids2).not.toContain('boundary');
  });
});
