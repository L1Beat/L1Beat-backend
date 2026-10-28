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
});
