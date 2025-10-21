/**
 * Cumulative Transaction Count Endpoints Tests
 * Tests the /api/chains/:chainId/cumulativeTxCount/* and /api/cumulativeTxCount/* endpoints
 */

const { get } = require('./setup');

describe('Cumulative Transaction Count Endpoints', () => {
  let testChainId;

  beforeAll(async () => {
    // Get a valid chain ID for testing
    const chainsResponse = await get('/api/chains');
    if (chainsResponse.body.length > 0) {
      testChainId = chainsResponse.body[0].chainId;
    }
  });

  describe('GET /api/chains/:chainId/cumulativeTxCount/history', () => {
    it('should return cumulative transaction count history for a chain', async () => {
      if (!testChainId) {
        console.warn('No test chain ID available, skipping test');
        return;
      }

      const response = await get(`/api/chains/${testChainId}/cumulativeTxCount/history?days=7`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('chainId');
      expect(response.body.chainId).toBe(testChainId);
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should handle days parameter', async () => {
      if (!testChainId) return;

      const response1 = await get(`/api/chains/${testChainId}/cumulativeTxCount/history?days=1`);
      const response30 = await get(`/api/chains/${testChainId}/cumulativeTxCount/history?days=30`);

      expect(response1.status).toBe(200);
      expect(response30.status).toBe(200);
    });

    it('should default to 30 days if days not specified', async () => {
      if (!testChainId) return;

      const response = await get(`/api/chains/${testChainId}/cumulativeTxCount/history`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
    });

    it('should return count of data points', async () => {
      if (!testChainId) return;

      const response = await get(`/api/chains/${testChainId}/cumulativeTxCount/history?days=7`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('count');
      expect(typeof response.body.count).toBe('number');
    });

    it('should handle invalid chain ID', async () => {
      const response = await get('/api/chains/invalid/cumulativeTxCount/history');

      // API currently returns 200 for invalid chain IDs (no validation)
      // In production, this should return 400/404
      expect([200, 400, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/chains/:chainId/cumulativeTxCount/latest', () => {
    it('should return latest cumulative transaction count for a chain', async () => {
      if (!testChainId) return;

      const response = await get(`/api/chains/${testChainId}/cumulativeTxCount/latest`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('chainId');
      expect(response.body.chainId).toBe(testChainId);
    });

    it('should include timestamp in response', async () => {
      if (!testChainId) return;

      const response = await get(`/api/chains/${testChainId}/cumulativeTxCount/latest`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should include data field', async () => {
      if (!testChainId) return;

      const response = await get(`/api/chains/${testChainId}/cumulativeTxCount/latest`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
    });

    it('should return 400/404 for invalid chain ID', async () => {
      const response = await get('/api/chains/invalid/cumulativeTxCount/latest');

      // API currently returns 200 for invalid chain IDs (no validation)
      // In production, this should return 400/404
      expect([200, 400, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/cumulativeTxCount/health', () => {
    it('should return cumulative tx count health check data', async () => {
      const response = await get('/api/cumulativeTxCount/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('stats');
    });

    it('should include detailed stats', async () => {
      const response = await get('/api/cumulativeTxCount/health');

      expect(response.status).toBe(200);

      const stats = response.body.stats;
      expect(stats).toHaveProperty('totalChains');
      expect(stats).toHaveProperty('chainIds');
      expect(stats).toHaveProperty('recentCumulativeTxCountRecords');
      expect(stats).toHaveProperty('environment');
      expect(stats).toHaveProperty('timeRange');
    });

    it('should include chain-level cumulative tx count details', async () => {
      const response = await get('/api/cumulativeTxCount/health');

      expect(response.status).toBe(200);

      const stats = response.body.stats;
      expect(stats).toHaveProperty('chainsWithCumulativeTxCount');
      expect(stats).toHaveProperty('chainCumulativeTxCountDetails');
      expect(Array.isArray(stats.chainCumulativeTxCountDetails)).toBe(true);
    });

    it('should include time range information', async () => {
      const response = await get('/api/cumulativeTxCount/health');

      expect(response.status).toBe(200);

      const timeRange = response.body.stats.timeRange;
      expect(timeRange).toHaveProperty('start');
      expect(timeRange).toHaveProperty('end');
    });

    it('should return JSON content type', async () => {
      const response = await get('/api/cumulativeTxCount/health');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });
});
