/**
 * Transaction Count Endpoints Tests
 * Tests the /api/tx-count/* endpoints
 */

const { get } = require('./setup');

const DAY = 24 * 60 * 60;

describe('Transaction Count Endpoints', () => {
  describe('GET /api/tx-count/all/latest', () => {
    it('returns the latest complete day for every chain', async () => {
      const response = await get('/api/tx-count/all/latest');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.count).toBe(response.body.data.length);

      const now = Math.floor(Date.now() / 1000);
      const latestCompleteDay = now - (now % DAY) - DAY;

      for (const item of response.body.data) {
        expect(item).toHaveProperty('evmChainId');
        expect(item).toHaveProperty('chainName');
        if (item.txCount === null) continue;
        expect(typeof item.txCount.value).toBe('number');
        expect(item.txCount.previous === null || typeof item.txCount.previous === 'number').toBe(true);
        // Never today's in-progress bucket.
        expect(item.txCount.timestamp).toBe(latestCompleteDay);
      }
    });
  });

  describe('GET /api/active-addresses/all/latest', () => {
    it('returns the latest complete day for every chain', async () => {
      const response = await get('/api/active-addresses/all/latest');

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(response.body.data.length);
      for (const item of response.body.data) {
        expect(item).toHaveProperty('evmChainId');
        expect(item).toHaveProperty('activeAddresses');
        if (item.activeAddresses === null) continue;
        expect(typeof item.activeAddresses.value).toBe('number');
      }
    });
  });

  describe('GET /api/chains/:chainId/metrics/history', () => {
    it('returns one array per requested metric, matching the per-metric routes', async () => {
      // A fixed ID, so this also runs against an empty test database.
      const id = 43114;

      const response = await get(`/api/chains/${id}/metrics/history?days=7&metrics=txCount,gasUsed`);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body.data).sort()).toEqual(['gasUsed', 'txCount']);

      const single = await get(`/api/chains/${id}/tx-count/history?days=7`);
      expect(response.body.data.txCount).toEqual(single.body.data);
    });

    it('returns all metrics when none are named', async () => {
      const response = await get('/api/chains/43114/metrics/history?days=3');
      expect(response.status).toBe(200);
      expect(Object.keys(response.body.data).sort()).toEqual(
        ['activeAddresses', 'avgGasPrice', 'feesPaid', 'gasUsed', 'maxTps', 'txCount']
      );
    });

    it('rejects unknown metrics and bad days', async () => {
      expect((await get('/api/chains/43114/metrics/history?metrics=txCount,nope')).status).toBe(400);
      expect((await get('/api/chains/43114/metrics/history?days=0')).status).toBe(400);
    });
  });

  describe('GET /api/tx-count/network/history', () => {
    it('returns how many chains each day adds up', async () => {
      const response = await get('/api/tx-count/network/history?days=7');

      expect(response.status).toBe(200);
      for (const row of response.body.data) {
        expect(typeof row.value).toBe('number');
        expect(Number.isInteger(row.chainCount)).toBe(true);
        expect(row.chainCount).toBeGreaterThan(0);
      }
    });
  });
});
