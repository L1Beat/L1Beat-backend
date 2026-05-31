/**
 * Unit tests for the shared metric service factory.
 * Focuses on the one behavioral branch that differs between metrics:
 * network-wide aggregation (sum vs. average).
 */

// Chain model is required by the factory but unused in these query paths.
jest.mock('../src/models/chain', () => ({ find: jest.fn() }));
jest.mock('axios');

const axios = require('axios');
const createMetricService = require('../src/services/metricService');

/**
 * Build a fake Mongoose-like model backed by an in-memory row set.
 * Supports the chainable find().sort().lean() / findOne().sort().lean() shapes
 * the factory uses.
 */
function fakeModel(rows) {
  const chainable = (result) => ({
    sort: () => ({ lean: async () => result }),
    lean: async () => result
  });
  return {
    find: (query = {}) => {
      let result = rows;
      // Exact-timestamp lookup (used by network-latest). Range queries return
      // everything here so the test exercises aggregation, not date filtering.
      if (query.timestamp && typeof query.timestamp === 'number') {
        result = rows.filter(r => r.timestamp === query.timestamp);
      }
      return chainable(result);
    },
    findOne: () => {
      const latest = rows.length
        ? rows.reduce((a, b) => (b.timestamp > a.timestamp ? b : a))
        : null;
      return chainable(latest);
    }
  };
}

describe('createMetricService aggregation', () => {
  const rows = [
    { chainId: '1', timestamp: 100, value: 10 },
    { chainId: '2', timestamp: 100, value: 20 },
    { chainId: '1', timestamp: 200, value: 30 }
  ];

  describe("sum aggregation", () => {
    const svc = createMetricService({
      model: fakeModel(rows), metricPath: 'x', label: 'X', aggregation: 'sum'
    });

    it('sums values across chains per timestamp in network history', async () => {
      const history = await svc.getNetworkHistory(30);
      expect(history).toEqual([
        { timestamp: 100, value: 30 },
        { timestamp: 200, value: 30 }
      ]);
    });

    it('sums values for the latest timestamp in network latest', async () => {
      const latest = await svc.getNetworkLatest();
      // Latest timestamp is 200, which has a single chain with value 30.
      expect(latest).toEqual({ timestamp: 200, value: 30, chainCount: 1 });
    });
  });

  describe("avg aggregation", () => {
    const svc = createMetricService({
      model: fakeModel(rows), metricPath: 'x', label: 'X', aggregation: 'avg'
    });

    it('averages values across chains per timestamp in network history', async () => {
      const history = await svc.getNetworkHistory(30);
      expect(history).toEqual([
        { timestamp: 100, value: 15 }, // (10 + 20) / 2
        { timestamp: 200, value: 30 }  // 30 / 1
      ]);
    });

    it('averages values for the latest timestamp in network latest', async () => {
      const latest = await svc.getNetworkLatest();
      expect(latest).toEqual({ timestamp: 200, value: 30, chainCount: 1 });
    });
  });

  it('returns null from network latest when there is no data', async () => {
    const svc = createMetricService({
      model: fakeModel([]), metricPath: 'x', label: 'X'
    });
    expect(await svc.getNetworkLatest()).toBeNull();
  });

  it('validates required options', () => {
    expect(() => createMetricService({ metricPath: 'x', label: 'X' })).toThrow(/model/);
    expect(() => createMetricService({ model: {}, label: 'X' })).toThrow(/metricPath/);
    expect(() => createMetricService({ model: {}, metricPath: 'x' })).toThrow(/label/);
  });
});

describe('createMetricService updateData failure handling', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns a failure result (not undefined) when every attempt gets a non-array response', async () => {
    // API responds 200 with a body that has no `results` array, on every retry.
    axios.get.mockResolvedValue({ data: {} });

    const svc = createMetricService({ model: {}, metricPath: 'x', label: 'X' });
    const result = await svc.updateData('123', 2); // retryCount=2

    // The bug this guards: falling off the retry loop returned undefined, which
    // crashed updateAllChains on `undefined.success`.
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.chainId).toBe('123');
    expect(result.error).toMatch(/no valid response/i);
  });
});
