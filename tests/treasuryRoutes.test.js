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

  describe('GET /api/v1/treasuries (public)', () => {
    const HOLDER_FIELDS = [
      'id', 'name', 'ticker', 'exchange', 'kind', 'sponsor',
      'avax_held', 'aum_usd', 'nav_per_share',
      'staking_pct', 'staking_max_pct', 'sponsor_fee_pct',
      'as_of', 'source', 'source_url', 'website_url'
    ];
    const TOTAL_FIELDS = [
      'treasury_avax', 'etf_avax', 'combined_avax', 'treasury_count', 'etf_count',
      'avax_price_usd', 'circulating_supply_avax', 'circulating_supply_source', 'market_as_of',
      'combined_usd', 'combined_share_of_circulating_percent'
    ];

    it('returns exactly the documented fields', async () => {
      const response = await get('/api/v1/treasuries');

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(['holders', 'totals', 'updated_at']);
      expect(response.body.holders.map(h => h.id)).toEqual(holders.map(h => h.id));
      for (const holder of response.body.holders) {
        expect(Object.keys(holder)).toEqual(HOLDER_FIELDS);
      }
      expect(Object.keys(response.body.totals)).toEqual(TOTAL_FIELDS);
    });

    it('is open to any origin, unlike the internal routes', async () => {
      const open = await get('/api/v1/treasuries').set('Origin', 'https://example.com');
      expect(open.headers['access-control-allow-origin']).toBe('*');
      expect(open.headers['access-control-allow-credentials']).toBeUndefined();
      expect(open.headers['cross-origin-resource-policy']).toBe('cross-origin');

      const internal = await get('/api/treasuries').set('Origin', 'https://example.com');
      expect(internal.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
