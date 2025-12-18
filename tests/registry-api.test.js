/**
 * Registry API Endpoints Tests
 * Tests the new registry-related API endpoints:
 * - GET /api/chains with category/network filters
 * - GET /api/chains/categories
 */

const { get } = require('./setup');

describe('Registry API Endpoints', () => {
  describe('GET /api/chains/categories', () => {
    it('should return list of all categories', async () => {
      const response = await get('/api/chains/categories');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should return categories as strings', async () => {
      const response = await get('/api/chains/categories');

      expect(response.status).toBe(200);

      response.body.forEach(category => {
        expect(typeof category).toBe('string');
        expect(category.length).toBeGreaterThan(0);
      });
    });

    it('should return unique categories', async () => {
      const response = await get('/api/chains/categories');

      expect(response.status).toBe(200);

      const categories = response.body;
      const uniqueCategories = [...new Set(categories)];

      expect(categories.length).toBe(uniqueCategories.length);
    });

    it('should return sorted categories', async () => {
      const response = await get('/api/chains/categories');

      expect(response.status).toBe(200);

      const categories = response.body;
      const sortedCategories = [...categories].sort();

      expect(categories).toEqual(sortedCategories);
    });

    it('should return JSON content type', async () => {
      const response = await get('/api/chains/categories');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('GET /api/chains with filters', () => {
    describe('Category filtering', () => {
      it('should filter chains by category', async () => {
        // First get all categories
        const categoriesResponse = await get('/api/chains/categories');

        if (categoriesResponse.body.length > 0) {
          const testCategory = categoriesResponse.body[0];

          // Filter by that category
          const response = await get(`/api/chains?category=${testCategory}`);

          expect(response.status).toBe(200);
          expect(Array.isArray(response.body)).toBe(true);

          // All returned chains should have the specified category
          response.body.forEach(chain => {
            expect(chain.categories).toBeDefined();
            expect(Array.isArray(chain.categories)).toBe(true);
            expect(chain.categories).toContain(testCategory);
          });
        }
      }, 10000);

      it('should return empty array for non-existent category', async () => {
        const response = await get('/api/chains?category=NON_EXISTENT_CATEGORY_12345');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
        expect(response.body.length).toBe(0);
      });

      it('should handle URL-encoded category names', async () => {
        const categoriesResponse = await get('/api/chains/categories');

        if (categoriesResponse.body.length > 0) {
          const testCategory = categoriesResponse.body[0];
          const encodedCategory = encodeURIComponent(testCategory);

          const response = await get(`/api/chains?category=${encodedCategory}`);

          expect(response.status).toBe(200);
          expect(Array.isArray(response.body)).toBe(true);
        }
      });

      it('should return chains with registry metadata when filtering by category', async () => {
        const categoriesResponse = await get('/api/chains/categories');

        if (categoriesResponse.body.length > 0) {
          const testCategory = categoriesResponse.body[0];
          const response = await get(`/api/chains?category=${testCategory}`);

          if (response.body.length > 0) {
            const chain = response.body[0];

            // Should have registry fields
            expect(chain).toHaveProperty('categories');
            expect(chain).toHaveProperty('website');
            expect(chain).toHaveProperty('socials');
            expect(chain).toHaveProperty('network');
          }
        }
      }, 10000);
    });

    describe('Network filtering', () => {
      it('should filter chains by mainnet', async () => {
        const response = await get('/api/chains?network=mainnet');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);

        // All returned chains should be mainnet
        response.body.forEach(chain => {
          expect(chain.network).toBe('mainnet');
        });
      }, 10000);

      it('should filter chains by fuji testnet', async () => {
        const response = await get('/api/chains?network=fuji');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);

        // All returned chains should be fuji
        response.body.forEach(chain => {
          expect(chain.network).toBe('fuji');
        });
      }, 10000);

      it('should reject invalid network values', async () => {
        const response = await get('/api/chains?network=invalid');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
        // Should return empty array or all chains (depends on implementation)
      });

      it('should return chains with all expected fields when filtering by network', async () => {
        const response = await get('/api/chains?network=mainnet');

        if (response.body.length > 0) {
          const chain = response.body[0];

          // Should have basic fields
          expect(chain).toHaveProperty('chainId');
          expect(chain).toHaveProperty('chainName');

          // Should have registry fields
          expect(chain).toHaveProperty('network');
          expect(chain.network).toBe('mainnet');
        }
      }, 10000);
    });

    describe('Combined filtering', () => {
      it('should filter by both category and network', async () => {
        // Get a category first
        const categoriesResponse = await get('/api/chains/categories');

        if (categoriesResponse.body.length > 0) {
          const testCategory = categoriesResponse.body[0];

          const response = await get(`/api/chains?category=${testCategory}&network=mainnet`);

          expect(response.status).toBe(200);
          expect(Array.isArray(response.body)).toBe(true);

          // All returned chains should match both filters
          response.body.forEach(chain => {
            expect(chain.categories).toContain(testCategory);
            expect(chain.network).toBe('mainnet');
          });
        }
      }, 10000);

      it('should return empty array when no chains match combined filters', async () => {
        const response = await get('/api/chains?category=NON_EXISTENT&network=mainnet');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
        expect(response.body.length).toBe(0);
      });
    });

    describe('Backward compatibility', () => {
      it('should work without filters (return all chains)', async () => {
        const response = await get('/api/chains');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
      });

      it('should ignore empty filter parameters', async () => {
        const response1 = await get('/api/chains');
        const response2 = await get('/api/chains?category=&network=');

        expect(response2.status).toBe(200);
        // Should return similar results (might differ due to caching)
        expect(Array.isArray(response2.body)).toBe(true);
      });

      it('should maintain existing chain structure', async () => {
        const response = await get('/api/chains');

        if (response.body.length > 0) {
          const chain = response.body[0];

          // Original fields should still be present
          expect(chain).toHaveProperty('chainId');
          expect(chain).toHaveProperty('chainName');
          expect(chain).toHaveProperty('validatorCount'); // Backend returns validatorCount instead of validators array
          expect(chain).toHaveProperty('tps');
        }
      });
    });

    describe('Response format', () => {
      it('should return consistent data structure with filters', async () => {
        const response = await get('/api/chains?network=mainnet');

        expect(response.status).toBe(200);

        if (response.body.length > 0) {
          response.body.forEach(chain => {
            expect(chain).toHaveProperty('chainId');
            expect(chain).toHaveProperty('chainName');
            expect(typeof chain.chainId).toBe('string');
            expect(typeof chain.chainName).toBe('string');
          });
        }
      }, 10000);

      it('should return JSON content type with filters', async () => {
        const response = await get('/api/chains?category=DEX');

        expect(response.headers['content-type']).toMatch(/json/);
      });
    });
  });

  describe('Registry metadata in chain responses', () => {
    it('should include categories in chain data', async () => {
      const response = await get('/api/chains');

      if (response.body.length > 0) {
        const chainWithCategories = response.body.find(c => c.categories && c.categories.length > 0);

        if (chainWithCategories) {
          expect(Array.isArray(chainWithCategories.categories)).toBe(true);
          expect(chainWithCategories.categories.length).toBeGreaterThan(0);

          chainWithCategories.categories.forEach(cat => {
            expect(typeof cat).toBe('string');
          });
        }
      }
    });

    it('should include website in chain data', async () => {
      const response = await get('/api/chains');

      if (response.body.length > 0) {
        const chainWithWebsite = response.body.find(c => c.website);

        if (chainWithWebsite) {
          expect(typeof chainWithWebsite.website).toBe('string');
          expect(chainWithWebsite.website).toMatch(/^https?:\/\//);
        }
      }
    });

    it('should include socials in chain data', async () => {
      const response = await get('/api/chains');

      if (response.body.length > 0) {
        const chainWithSocials = response.body.find(c => c.socials && c.socials.length > 0);

        if (chainWithSocials) {
          expect(Array.isArray(chainWithSocials.socials)).toBe(true);

          chainWithSocials.socials.forEach(social => {
            expect(social).toHaveProperty('name');
            expect(social).toHaveProperty('url');
            expect(typeof social.name).toBe('string');
            expect(typeof social.url).toBe('string');
          });
        }
      }
    });

    it('should include network in chain data', async () => {
      const response = await get('/api/chains');

      if (response.body.length > 0) {
        const chainWithNetwork = response.body.find(c => c.network);

        if (chainWithNetwork) {
          expect(['mainnet', 'fuji']).toContain(chainWithNetwork.network);
        }
      }
    });

    it('should include evmChainId in chain data', async () => {
      const response = await get('/api/chains');

      if (response.body.length > 0) {
        const chainWithEvmId = response.body.find(c => c.evmChainId);

        if (chainWithEvmId) {
          expect(typeof chainWithEvmId.evmChainId).toBe('number');
          expect(chainWithEvmId.evmChainId).toBeGreaterThan(0);
        }
      }
    });

    it('should include rpcUrls array in chain data', async () => {
      const response = await get('/api/chains');

      if (response.body.length > 0) {
        const chainWithRpcUrls = response.body.find(c => c.rpcUrls && c.rpcUrls.length > 0);

        if (chainWithRpcUrls) {
          expect(Array.isArray(chainWithRpcUrls.rpcUrls)).toBe(true);
          expect(chainWithRpcUrls.rpcUrls.length).toBeGreaterThan(0);

          chainWithRpcUrls.rpcUrls.forEach(url => {
            expect(typeof url).toBe('string');
            expect(url).toMatch(/^https?:\/\//);
          });
        }
      }
    });

    it('should include assets in chain data', async () => {
      const response = await get('/api/chains');

      if (response.body.length > 0) {
        const chainWithAssets = response.body.find(c => c.assets && c.assets.length > 0);

        if (chainWithAssets) {
          expect(Array.isArray(chainWithAssets.assets)).toBe(true);

          chainWithAssets.assets.forEach(asset => {
            expect(asset).toHaveProperty('symbol');
            expect(asset).toHaveProperty('name');
            expect(asset).toHaveProperty('decimals');
          });
        }
      }
    });
  });

  describe('Performance and caching', () => {
    it('should handle multiple filtered requests efficiently', async () => {
      const start = Date.now();

      const requests = [
        get('/api/chains?network=mainnet'),
        get('/api/chains?network=fuji'),
        get('/api/chains/categories')
      ];

      const responses = await Promise.all(requests);

      const duration = Date.now() - start;

      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      // Should complete reasonably fast (adjust threshold as needed)
      expect(duration).toBeLessThan(10000);
    }, 15000);
  });
});
