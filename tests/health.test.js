/**
 * Health Check Endpoint Tests
 * Tests the /health endpoint
 */

const { get } = require('./setup');

describe('Health Check Endpoints', () => {
  describe('GET /health', () => {
    it('should return 200 OK with status', async () => {
      const response = await get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe('ok');
    });

    it('should return JSON content type', async () => {
      const response = await get('/health');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });
});
