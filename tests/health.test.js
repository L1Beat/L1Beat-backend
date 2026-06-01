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

    it('should report uptime and mongodb dependency state', async () => {
      const response = await get('/health');

      expect(typeof response.body.uptime).toBe('number');
      expect(response.body).toHaveProperty('dependencies.mongodb');
      expect(['connected', 'disconnected']).toContain(response.body.dependencies.mongodb);
    });
  });

  describe('GET /health/ready', () => {
    it('should return a readiness status and reflect mongodb state in the code', async () => {
      const response = await get('/health/ready');

      // 200 when Mongo is connected, 503 when it is draining/disconnected.
      expect([200, 503]).toContain(response.status);
      expect(response.body).toHaveProperty('status');
      if (response.body.dependencies.mongodb === 'connected') {
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('ok');
      } else {
        expect(response.status).toBe(503);
        expect(response.body.status).toBe('not_ready');
      }
    });
  });
});
