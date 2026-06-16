/**
 * Unit tests for TPS derivation in tpsService.updateTpsData.
 *
 * TPS is derived from the daily txCount already stored by txCountService (no
 * API call). These tests pin the derivation math:
 *   - completed day: tps = txCount / 86400
 *   - in-progress day: denominator floored to 1h so a tiny window can't spike
 *   - non-positive window (future timestamp): skipped
 *   - non-numeric value: skipped
 *
 * This file intentionally does NOT require ./setup, which globally mocks
 * tpsService — here we exercise the real implementation against mocked models.
 */

jest.mock('../src/models/tps', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/txCount', () => ({ find: jest.fn() }));
jest.mock('../src/models/cumulativeTxCount', () => ({}));
jest.mock('../src/models/chain', () => ({ find: jest.fn() }));
// cumulativeTxCount delegates to the shared factory; stub it so requiring
// tpsService doesn't spin up a real metric service.
jest.mock('../src/services/metricService', () => () => ({
  updateData: jest.fn(),
  updateAllChains: jest.fn(),
  getHistory: jest.fn(),
  getLatest: jest.fn(),
  getNetworkHistory: jest.fn(),
  getNetworkLatest: jest.fn()
}));

const TPS = require('../src/models/tps');
const TxCount = require('../src/models/txCount');
const tpsService = require('../src/services/tpsService');

const NOW_SECONDS = 1_700_000_000;
const DAY = 24 * 60 * 60;

// Make TxCount.find(...).select(...).lean() resolve to the given rows.
function stubTxCountRows(rows) {
  TxCount.find.mockReturnValue({
    select: () => ({ lean: async () => rows })
  });
}

// Capture the ops passed to TPS.bulkWrite and key them by timestamp.
function captureBulkWrite() {
  let ops = [];
  TPS.bulkWrite.mockImplementation(async (received) => {
    ops = received;
    return { upsertedCount: received.length, modifiedCount: 0 };
  });
  return () => ops.map(op => ({
    timestamp: op.updateOne.filter.timestamp,
    value: op.updateOne.update.$set.value
  }));
}

describe('tpsService.updateTpsData derivation', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000);
  });

  it('derives full-day TPS and floors the in-progress day denominator', async () => {
    const getWritten = captureBulkWrite();
    stubTxCountRows([
      // Completed day: well over 86400s ago → full-day window. 86400/86400 = 1.00
      { timestamp: NOW_SECONDS - 3 * DAY, value: 86400 },
      // In-progress day: only 600s elapsed → denominator floored to 3600s.
      // Without the floor this would spike to 1800/600 = 3.00; with it, 0.50.
      { timestamp: NOW_SECONDS - 600, value: 1800 }
    ]);

    const result = await tpsService.updateTpsData('42');

    expect(result.success).toBe(true);
    expect(result.recordsProcessed).toBe(2);

    const written = getWritten();
    expect(written).toContainEqual({ timestamp: NOW_SECONDS - 3 * DAY, value: 1 });
    expect(written).toContainEqual({ timestamp: NOW_SECONDS - 600, value: 0.5 });
  });

  it('skips future timestamps and non-numeric values', async () => {
    const getWritten = captureBulkWrite();
    stubTxCountRows([
      { timestamp: NOW_SECONDS - 2 * DAY, value: 43200 }, // valid → 0.50
      { timestamp: NOW_SECONDS + 100, value: 999 },        // future → elapsed <= 0, skip
      { timestamp: NOW_SECONDS - DAY, value: 'oops' }      // NaN value → skip
    ]);

    const result = await tpsService.updateTpsData('42');

    expect(result.recordsProcessed).toBe(1);
    const written = getWritten();
    expect(written).toEqual([{ timestamp: NOW_SECONDS - 2 * DAY, value: 0.5 }]);
  });

  it('returns a no-op success result when there is no txCount data', async () => {
    stubTxCountRows([]);

    const result = await tpsService.updateTpsData('42');

    expect(result).toMatchObject({ success: true, recordsProcessed: 0 });
    expect(TPS.bulkWrite).not.toHaveBeenCalled();
  });

  it('returns a failure result (not a throw) when the write fails', async () => {
    stubTxCountRows([{ timestamp: NOW_SECONDS - 2 * DAY, value: 43200 }]);
    TPS.bulkWrite.mockRejectedValue(new Error('db down'));

    const result = await tpsService.updateTpsData('42');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/db down/);
  });
});
