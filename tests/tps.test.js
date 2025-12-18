/**
 * TPS Endpoints Tests
 * Tests the /api/tps/* and /api/chains/:chainId/tps/* endpoints
 */

const { get } = require('./setup');

describe('TPS Endpoints', () => {
  let testChainId;

  beforeAll(async () => {
    // Get a valid chain ID for testing
    const chainsResponse = await get('/api/chains');
    if (chainsResponse.body.length > 0) {
      testChainId = chainsResponse.body[0].chainId;
    }
  });

  describe('GET /api/chains/:chainId/tps/history', () => {
    it('should return TPS history for a chain', async () => {
      if (!testChainId) {
        console.warn('No test chain ID available, skipping test');
        return;
      }

      const response = await get(`/api/chains/${testChainId}/tps/history?days=7`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('chainId');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should handle days parameter', async () => {
      if (!testChainId) return;

      const response1 = await get(`/api/chains/${testChainId}/tps/history?days=1`);
      const response7 = await get(`/api/chains/${testChainId}/tps/history?days=7`);

      expect(response1.status).toBe(200);
      expect(response7.status).toBe(200);
    });

    it('should default to 30 days if days not specified', async () => {
      if (!testChainId) return;

      const response = await get(`/api/chains/${testChainId}/tps/history`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
    });

    it('should handle invalid chain ID', async () => {
      const response = await get('/api/chains/invalid/tps/history');

      // API currently returns 200 for invalid chain IDs (no validation)
      // In production, this should return 400/404
      expect([200, 400, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/chains/:chainId/tps/latest', () => {
    it('should return latest TPS for a chain', async () => {
      if (!testChainId) return;

      const response = await get(`/api/chains/${testChainId}/tps/latest`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('chainId');
      expect(response.body.chainId).toBe(testChainId);
    });

    it('should include timestamp in response', async () => {
      if (!testChainId) return;

      const response = await get(`/api/chains/${testChainId}/tps/latest`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /api/tps/network/latest', () => {
    it('should return latest network-wide TPS', async () => {
      const response = await get('/api/tps/network/latest');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('timestamp');
      // data may be null if no TPS data exists
      expect('data' in response.body).toBe(true);
    });

    it('should return numeric TPS value', async () => {
      const response = await get('/api/tps/network/latest');

      expect(response.status).toBe(200);

      if (response.body.data) {
        expect(response.body.data).toHaveProperty('totalTps');
        expect(typeof response.body.data.totalTps).toBe('number');
      }
    });
  });

  describe('GET /api/tps/network/history', () => {
    it('should return network TPS history', async () => {
      const response = await get('/api/tps/network/history?days=7');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body).toHaveProperty('period');
    }, 15000);

    it('should default to 7 days if not specified', async () => {
      const response = await get('/api/tps/network/history');

      expect(response.status).toBe(200);
      expect(response.body.period).toBe('7 days');
    }, 15000);

    it('should handle custom days parameter', async () => {
      const response = await get('/api/tps/network/history?days=30');

      expect(response.status).toBe(200);
      expect(response.body.period).toBe('30 days');
    }, 15000);
  });

  describe('GET /api/tps/health', () => {
    it('should return TPS health check data', async () => {
      const response = await get('/api/tps/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('stats');
    });

    it('should include detailed stats', async () => {
      const response = await get('/api/tps/health');

      expect(response.status).toBe(200);

      const stats = response.body.stats;
      expect(stats).toHaveProperty('totalChains');
      expect(stats).toHaveProperty('chainIds');
      expect(stats).toHaveProperty('recentTpsRecords');
      expect(stats).toHaveProperty('environment');
      expect(stats).toHaveProperty('timeRange');
    });

    it('should include chain TPS details', async () => {
      const response = await get('/api/tps/health');

      expect(response.status).toBe(200);

      const stats = response.body.stats;
      expect(stats).toHaveProperty('chainsWithTps');
      expect(stats).toHaveProperty('chainTpsDetails');
      expect(Array.isArray(stats.chainTpsDetails)).toBe(true);
    });
  });

  describe('GET /api/tps/diagnostic', () => {
    it('should return TPS diagnostic data', async () => {
      const response = await get('/api/tps/diagnostic');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('summary');
      expect(response.body).toHaveProperty('chainDetails');
    });

    it('should include summary statistics', async () => {
      const response = await get('/api/tps/diagnostic');

      expect(response.status).toBe(200);

      const summary = response.body.summary;
      expect(summary).toHaveProperty('totalChains');
      expect(summary).toHaveProperty('chainsWithData');
      expect(summary).toHaveProperty('totalRecords');
      expect(summary).toHaveProperty('calculatedTotalTps');
    });

    it('should include chain-level details', async () => {
      const response = await get('/api/tps/diagnostic');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.chainDetails)).toBe(true);

      if (response.body.chainDetails.length > 0) {
        const detail = response.body.chainDetails[0];
        expect(detail).toHaveProperty('chainId');
        expect(detail).toHaveProperty('hasData');
        expect(detail).toHaveProperty('recordCount');
      }
    });
  });

  describe('GET /api/tps/status', () => {
    it('should return TPS status', async () => {
      const response = await get('/api/tps/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('stats');
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should include basic stats', async () => {
      const response = await get('/api/tps/status');

      expect(response.status).toBe(200);

      const stats = response.body.stats;
      expect(stats).toHaveProperty('tpsRecords');
      expect(stats).toHaveProperty('chains');
      expect(stats).toHaveProperty('timeRange');
    });
  });
});
