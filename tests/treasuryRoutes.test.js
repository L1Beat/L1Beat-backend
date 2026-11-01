/**
 * Treasury Endpoints Tests
 * Tests the /api/treasuries* endpoints against the test DB
 */

const { get } = require('./setup');
const { holders } = require('../src/config/treasuries');

describe('Treasury Endpoints', () => {
  describe('GET /api/treasuries', () => {
    it('lists every configured holder with totals', async () => {
      const response = await get('/api/treasuries');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.holders.map(h => h.id)).toEqual(holders.map(h => h.id));
      for (const holder of response.body.holders) {
        expect(['treasury', 'etf']).toContain(holder.kind);
        // Unknown is null, never 0.
        expect(holder.avax_held === null || holder.avax_held > 0).toBe(true);
      }
      expect(response.body.totals).toHaveProperty('combined_avax');
      expect(response.body.totals).toHaveProperty('avax_price_usd');
      expect(response.body).toHaveProperty('updated_at');
    });
  });

  describe('GET /api/treasuries/history', () => {
    it('returns a history array per holder', async () => {
      const response = await get('/api/treasuries/history?days=7');

      expect(response.status).toBe(200);
      expect(response.body.days).toBe(7);
      expect(response.body.holders).toHaveLength(holders.length);
      for (const holder of response.body.holders) {
        expect(Array.isArray(holder.history)).toBe(true);
      }
    });

    it('rejects days out of range', async () => {
      const response = await get('/api/treasuries/history?days=0');
      expect(response.status).toBe(400);
    });
  });
});
