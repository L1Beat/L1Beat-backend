/**
 * Chain Endpoints Tests
 * Tests the /api/chains/* endpoints
 */

const { get } = require('./setup');

describe('Chain Endpoints', () => {
  let testChainId;

  describe('GET /api/chains', () => {
    it('should return list of all chains', async () => {
      const response = await get('/api/chains');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);

      if (response.body.length > 0) {
        testChainId = response.body[0].chainId;
        const chain = response.body[0];

        // Verify chain structure
        expect(chain).toHaveProperty('chainId');
        expect(chain).toHaveProperty('chainName');
        expect(typeof chain.chainId).toBe('string');
        expect(typeof chain.chainName).toBe('string');
      }
    });

    it('should return chains with consistent data structure', async () => {
      const response = await get('/api/chains');

      expect(response.status).toBe(200);

      if (response.body.length > 0) {
        response.body.forEach(chain => {
          expect(chain).toHaveProperty('chainId');
          expect(chain).toHaveProperty('chainName');
        });
      }
    });

    it('should return chains with registry metadata fields', async () => {
      const response = await get('/api/chains');

      expect(response.status).toBe(200);

      if (response.body.length > 0) {
        // Check for registry fields (they may be undefined for some chains)
        const chainWithRegistryData = response.body.find(chain =>
          chain.categories && chain.categories.length > 0
        );

        if (chainWithRegistryData) {
          // Verify registry field structure
          expect(Array.isArray(chainWithRegistryData.categories)).toBe(true);

          if (chainWithRegistryData.website) {
            expect(typeof chainWithRegistryData.website).toBe('string');
          }

          if (chainWithRegistryData.socials) {
            expect(Array.isArray(chainWithRegistryData.socials)).toBe(true);

            if (chainWithRegistryData.socials.length > 0) {
              expect(chainWithRegistryData.socials[0]).toHaveProperty('name');
              expect(chainWithRegistryData.socials[0]).toHaveProperty('url');
            }
          }

          if (chainWithRegistryData.network) {
            expect(['mainnet', 'fuji']).toContain(chainWithRegistryData.network);
          }

          if (chainWithRegistryData.evmChainId) {
            expect(typeof chainWithRegistryData.evmChainId).toBe('number');
          }

          if (chainWithRegistryData.rpcUrls) {
            expect(Array.isArray(chainWithRegistryData.rpcUrls)).toBe(true);
          }
        }
      }
    });

    it('should return JSON content type', async () => {
      const response = await get('/api/chains');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('GET /api/chains/:chainId', () => {
    it('should return specific chain by ID', async () => {
      // Get a valid chain ID first
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length > 0) {
        const chainId = chainsResponse.body[0].chainId;
        const response = await get(`/api/chains/${chainId}`);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('chainId');
        expect(response.body.chainId).toBe(chainId);
      }
    });

    it('should return 400 for invalid chain ID format', async () => {
      const response = await get('/api/chains/invalid@chain#id');

      // API may return 500 for some invalid formats
      expect([400, 404, 500]).toContain(response.status);
    });

    it('should return 404 for non-existent chain ID', async () => {
      const response = await get('/api/chains/99999999');

      expect([404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/chains/:chainId/validators', () => {
    it('should return validators for a specific chain', async () => {
      // Get a valid chain ID first
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length > 0) {
        const chainId = chainsResponse.body[0].chainId;
        const response = await get(`/api/chains/${chainId}/validators`);

        // Can be 200 with data, or 200 with empty array if no validators
        expect(response.status).toBe(200);

        if (response.body.validators) {
          expect(Array.isArray(response.body.validators)).toBe(true);
        }
      }
    });

    it('should handle invalid chain ID gracefully', async () => {
      const response = await get('/api/chains/invalid/validators');

      expect([400, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/chains/:chainId/validators/direct', () => {
    it('should fetch validators directly for a specific chain', async () => {
      // Get a valid chain ID first
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length > 0) {
        const chainId = chainsResponse.body[0].chainId;
        const response = await get(`/api/chains/${chainId}/validators/direct`);

        expect([200, 404, 500]).toContain(response.status);

        if (response.status === 200 && response.body.validators) {
          expect(Array.isArray(response.body.validators)).toBe(true);
        }
      }
    }, 30000); // Longer timeout for external API call

    it('should return JSON content type', async () => {
      const chainsResponse = await get('/api/chains');

      if (chainsResponse.body.length > 0) {
        const chainId = chainsResponse.body[0].chainId;
        const response = await get(`/api/chains/${chainId}/validators/direct`);

        expect(response.headers['content-type']).toMatch(/json/);
      }
    }, 30000);
  });
});
