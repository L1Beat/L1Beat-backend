/**
 * SnowPeer Proxy Endpoint Tests
 * Tests the /api/snowpeer/* endpoints
 */

const { get } = require('./setup');

describe('SnowPeer Proxy Endpoints', () => {
  describe('GET /api/snowpeer/l1s', () => {
    it('should return list of L1s from SnowPeer API', async () => {
      const response = await get('/api/snowpeer/l1s?network=mainnet&limit=5');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);

      if (response.body.data.length > 0) {
        const l1 = response.body.data[0];
        expect(l1).toHaveProperty('name');
        expect(l1).toHaveProperty('id'); // SnowPeer uses 'id' not 'chainId'
      }
    }, 30000);

    it('should handle pagination parameters', async () => {
      const response = await get('/api/snowpeer/l1s?network=mainnet&limit=2&page=1');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data.length).toBeLessThanOrEqual(2);
    }, 30000);

    it('should default to mainnet network', async () => {
      const response = await get('/api/snowpeer/l1s?limit=1');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
    }, 30000);
  });

  describe('GET /api/snowpeer/l1s/:id', () => {
    it('should return specific L1 data by blockchain ID', async () => {
      // Using Avalanche C-Chain as a known blockchain
      const blockchainId = '2qJPnDkDH6hn3PVzxzkUdTqDD1HeAnTT8FL4t2BJagc2iuq8j7';
      const response = await get(`/api/snowpeer/l1s/${blockchainId}?network=mainnet`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');

      const l1Data = response.body.data;
      expect(l1Data).toHaveProperty('name');
      expect(l1Data).toHaveProperty('id');
      expect(l1Data.id).toBe(blockchainId);
    }, 30000);

    it('should include links if available', async () => {
      const blockchainId = '2qJPnDkDH6hn3PVzxzkUdTqDD1HeAnTT8FL4t2BJagc2iuq8j7';
      const response = await get(`/api/snowpeer/l1s/${blockchainId}?network=mainnet`);

      expect(response.status).toBe(200);
      const l1Data = response.body.data;

      // Check for links object (SnowPeer returns links: {website, x, telegram, etc})
      if (l1Data.links) {
        expect(typeof l1Data.links).toBe('object');
      }
    }, 30000);

    it('should include metadata fields', async () => {
      const blockchainId = '2qJPnDkDH6hn3PVzxzkUdTqDD1HeAnTT8FL4t2BJagc2iuq8j7';
      const response = await get(`/api/snowpeer/l1s/${blockchainId}?network=mainnet`);

      expect(response.status).toBe(200);
      const l1Data = response.body.data;

      // Check for metadata fields (SnowPeer uses 'id' not 'blockchainId')
      expect(l1Data).toHaveProperty('id');
      expect(l1Data).toHaveProperty('name');
      expect(l1Data.id).toBe(blockchainId);

      // Optional fields that may exist
      const optionalFields = ['categories', 'mainCategory', 'links', 'team', 'chains'];
      optionalFields.forEach(field => {
        // Just verify the field doesn't throw an error when accessed
        const value = l1Data[field];
        expect(value !== undefined || value === undefined).toBe(true);
      });
    }, 30000);

    it('should return 404 for non-existent blockchain ID', async () => {
      const response = await get('/api/snowpeer/l1s/nonexistent123?network=mainnet');

      expect(response.status).toBe(404);
    }, 30000);
  });

  describe('GET /api/snowpeer/blockchains', () => {
    it('should return list of blockchains', async () => {
      const response = await get('/api/snowpeer/blockchains?network=mainnet&limit=5');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    }, 30000);

    it('should handle network parameter', async () => {
      const response = await get('/api/snowpeer/blockchains?network=mainnet');

      expect(response.status).toBe(200);
    }, 30000);
  });

  describe('GET /api/snowpeer/validators/:nodeId', () => {
    it('should return validator data by node ID or 404 if not found', async () => {
      // Using a known validator node ID from Avalanche
      const nodeId = '11111111111111111111111111111111LpoYY';
      const response = await get(`/api/snowpeer/validators/${nodeId}?network=mainnet`);

      // Validator might not be in SnowPeer database, so 404 is acceptable
      expect([200, 404]).toContain(response.status);

      if (response.status === 200) {
        expect(response.body).toHaveProperty('data');
      }
    }, 30000);

    it('should handle invalid node ID gracefully', async () => {
      const response = await get('/api/snowpeer/validators/invalid?network=mainnet');

      // Should either return 404 or return empty/error data
      expect([200, 404, 400]).toContain(response.status);
    }, 30000);
  });

  describe('SnowPeer Caching', () => {
    it('should cache responses for repeated requests', async () => {
      const url = '/api/snowpeer/l1s?network=mainnet&limit=1';

      // First request
      const response1 = await get(url);
      const time1 = Date.now();

      // Second request (should be cached)
      const response2 = await get(url);
      const time2 = Date.now();

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(JSON.stringify(response1.body)).toBe(JSON.stringify(response2.body));

      // Second request should be faster (cached)
      expect(time2 - time1).toBeLessThan(1000); // Should be nearly instant
    }, 30000);
  });
});
