/**
 * Teleporter Endpoints Tests
 * Tests the /api/teleporter/* endpoints
 */

const { get } = require('./setup');

describe('Teleporter Endpoints', () => {
  describe('GET /api/teleporter/messages/daily-count', () => {
    it('should return daily cross-chain message count', async () => {
      const response = await get('/api/teleporter/messages/daily-count');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should handle fromChain parameter', async () => {
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length > 0) {
        const chainId = chainsResponse.body[0].chainId;
        const response = await get(`/api/teleporter/messages/daily-count?fromChain=${chainId}`);

        expect(response.status).toBe(200);
      }
    });

    it('should handle toChain parameter', async () => {
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length > 0) {
        const chainId = chainsResponse.body[0].chainId;
        const response = await get(`/api/teleporter/messages/daily-count?toChain=${chainId}`);

        expect(response.status).toBe(200);
      }
    });

    it('should handle both fromChain and toChain parameters', async () => {
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length >= 2) {
        const fromChain = chainsResponse.body[0].chainId;
        const toChain = chainsResponse.body[1].chainId;
        const response = await get(`/api/teleporter/messages/daily-count?fromChain=${fromChain}&toChain=${toChain}`);

        expect(response.status).toBe(200);
      }
    });

    it('should return JSON content type', async () => {
      const response = await get('/api/teleporter/messages/daily-count');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('GET /api/teleporter/messages/weekly-count', () => {
    it('should return weekly cross-chain message count', async () => {
      const response = await get('/api/teleporter/messages/weekly-count');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should handle fromChain parameter', async () => {
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length > 0) {
        const chainId = chainsResponse.body[0].chainId;
        const response = await get(`/api/teleporter/messages/weekly-count?fromChain=${chainId}`);

        expect(response.status).toBe(200);
      }
    });

    it('should handle toChain parameter', async () => {
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length > 0) {
        const chainId = chainsResponse.body[0].chainId;
        const response = await get(`/api/teleporter/messages/weekly-count?toChain=${chainId}`);

        expect(response.status).toBe(200);
      }
    });

    it('should handle both fromChain and toChain parameters', async () => {
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length >= 2) {
        const fromChain = chainsResponse.body[0].chainId;
        const toChain = chainsResponse.body[1].chainId;
        const response = await get(`/api/teleporter/messages/weekly-count?fromChain=${fromChain}&toChain=${toChain}`);

        expect(response.status).toBe(200);
      }
    });

    it('should return JSON content type', async () => {
      const response = await get('/api/teleporter/messages/weekly-count');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('GET /api/teleporter/messages/historical-daily', () => {
    it('should return historical daily message counts', async () => {
      const response = await get('/api/teleporter/messages/historical-daily');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should handle days parameter', async () => {
      const response7 = await get('/api/teleporter/messages/historical-daily?days=7');
      const response30 = await get('/api/teleporter/messages/historical-daily?days=30');

      expect(response7.status).toBe(200);
      expect(response30.status).toBe(200);
    });

    it('should handle fromChain parameter', async () => {
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length > 0) {
        const chainId = chainsResponse.body[0].chainId;
        const response = await get(`/api/teleporter/messages/historical-daily?fromChain=${chainId}&days=7`);

        expect(response.status).toBe(200);
      }
    });

    it('should handle toChain parameter', async () => {
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length > 0) {
        const chainId = chainsResponse.body[0].chainId;
        const response = await get(`/api/teleporter/messages/historical-daily?toChain=${chainId}&days=7`);

        expect(response.status).toBe(200);
      }
    });

    it('should handle combined parameters', async () => {
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length >= 2) {
        const fromChain = chainsResponse.body[0].chainId;
        const toChain = chainsResponse.body[1].chainId;
        const response = await get(`/api/teleporter/messages/historical-daily?fromChain=${fromChain}&toChain=${toChain}&days=7`);

        expect(response.status).toBe(200);
      }
    });

    it('should return data array', async () => {
      const response = await get('/api/teleporter/messages/historical-daily?days=7');

      expect(response.status).toBe(200);

      if (response.body.data) {
        expect(Array.isArray(response.body.data)).toBe(true);
      }
    });

    it('should return JSON content type', async () => {
      const response = await get('/api/teleporter/messages/historical-daily');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });
});
