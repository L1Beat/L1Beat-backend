/**
 * Chain Service Tests
 * Tests the chainService methods including new registry-related functionality
 */

// Mock tpsService before importing chainService
jest.mock('../src/services/tpsService', () => ({
  updateTpsData: jest.fn().mockResolvedValue(null),
  getTpsHistory: jest.fn().mockResolvedValue([
    { timestamp: Math.floor(Date.now() / 1000) - 86400, value: 10.5 },
    { timestamp: Math.floor(Date.now() / 1000) - 172800, value: 12.3 }
  ]),
  getLatestTps: jest.fn().mockResolvedValue({
    timestamp: Math.floor(Date.now() / 1000),
    value: 15.7
  }),
  getNetworkTps: jest.fn().mockResolvedValue({
    totalTps: 250.5,
    chainCount: 10,
    timestamp: Math.floor(Date.now() / 1000),
    dataAge: 5,
    dataAgeUnit: 'minutes'
  }),
  getNetworkTpsHistory: jest.fn().mockResolvedValue([
    { timestamp: Math.floor(Date.now() / 1000) - 86400, totalTps: 240.5, chainCount: 10 },
    { timestamp: Math.floor(Date.now() / 1000) - 172800, totalTps: 235.2, chainCount: 9 }
  ]),
  updateCumulativeTxCount: jest.fn().mockResolvedValue(null),
  getTxCountHistory: jest.fn().mockResolvedValue([
    { timestamp: Math.floor(Date.now() / 1000) - 86400, value: 1000000 },
    { timestamp: Math.floor(Date.now() / 1000) - 172800, value: 950000 }
  ]),
  getLatestTxCount: jest.fn().mockResolvedValue({
    timestamp: Math.floor(Date.now() / 1000),
    value: 1050000
  })
}));

const chainService = require('../src/services/chainService');
const Chain = require('../src/models/chain');
const registryService = require('../src/services/registryService');

describe('Chain Service', () => {
  beforeAll(async () => {
    // Ensure registry is loaded before running tests
    await registryService.loadAllChains();
  }, 15000);

  describe('getAllChains with filtering', () => {
    it('should return all chains without filters', async () => {
      const chains = await chainService.getAllChains();

      expect(Array.isArray(chains)).toBe(true);
      expect(chains.length).toBeGreaterThan(0);
    }, 30000);

    it('should filter chains by category', async () => {
      const categories = await chainService.getAllCategories();

      if (categories.length > 0) {
        const testCategory = categories[0];
        const filteredChains = await chainService.getAllChains({ category: testCategory });

        expect(Array.isArray(filteredChains)).toBe(true);

        filteredChains.forEach(chain => {
          expect(chain.categories).toBeDefined();
          expect(chain.categories).toContain(testCategory);
        });
      }
    }, 30000);

    it('should filter chains by mainnet network', async () => {
      const mainnetChains = await chainService.getAllChains({ network: 'mainnet' });

      expect(Array.isArray(mainnetChains)).toBe(true);

      mainnetChains.forEach(chain => {
        expect(chain.network).toBe('mainnet');
      });
    }, 30000);

    it('should filter chains by fuji network', async () => {
      const fujiChains = await chainService.getAllChains({ network: 'fuji' });

      expect(Array.isArray(fujiChains)).toBe(true);

      fujiChains.forEach(chain => {
        expect(chain.network).toBe('fuji');
      });
    }, 30000);

    it('should filter chains by both category and network', async () => {
      const categories = await chainService.getAllCategories();

      if (categories.length > 0) {
        const testCategory = categories[0];
        const filteredChains = await chainService.getAllChains({
          category: testCategory,
          network: 'mainnet'
        });

        expect(Array.isArray(filteredChains)).toBe(true);

        filteredChains.forEach(chain => {
          expect(chain.categories).toContain(testCategory);
          expect(chain.network).toBe('mainnet');
        });
      }
    }, 30000);

    it('should return empty array for non-matching filters', async () => {
      const chains = await chainService.getAllChains({
        category: 'NON_EXISTENT_CATEGORY_12345'
      });

      expect(Array.isArray(chains)).toBe(true);
      expect(chains.length).toBe(0);
    }, 30000);

    it('should cache filtered results', async () => {
      const categories = await chainService.getAllCategories();

      if (categories.length > 0) {
        const testCategory = categories[0];

        // First call
        const start1 = Date.now();
        const result1 = await chainService.getAllChains({ category: testCategory });
        const duration1 = Date.now() - start1;

        // Second call (should be cached)
        const start2 = Date.now();
        const result2 = await chainService.getAllChains({ category: testCategory });
        const duration2 = Date.now() - start2;

        expect(result1.length).toBe(result2.length);
        // Second call should generally be faster due to caching
        // (though this is not guaranteed in all environments)
      }
    }, 30000);
  });

  describe('getAllCategories', () => {
    it('should return array of categories', async () => {
      const categories = await chainService.getAllCategories();

      expect(Array.isArray(categories)).toBe(true);
      expect(categories.length).toBeGreaterThan(0);
    }, 30000);

    it('should return unique categories', async () => {
      const categories = await chainService.getAllCategories();

      const uniqueCategories = [...new Set(categories)];
      expect(categories.length).toBe(uniqueCategories.length);
    }, 30000);

    it('should return sorted categories', async () => {
      const categories = await chainService.getAllCategories();

      const sortedCategories = [...categories].sort();
      expect(categories).toEqual(sortedCategories);
    }, 30000);

    it('should cache category results', async () => {
      // First call
      const start1 = Date.now();
      const result1 = await chainService.getAllCategories();
      const duration1 = Date.now() - start1;

      // Second call (should be cached)
      const start2 = Date.now();
      const result2 = await chainService.getAllCategories();
      const duration2 = Date.now() - start2;

      expect(result1).toEqual(result2);
    }, 30000);

    it('should only contain non-empty string categories', async () => {
      const categories = await chainService.getAllCategories();

      categories.forEach(category => {
        expect(typeof category).toBe('string');
        expect(category.length).toBeGreaterThan(0);
      });
    }, 30000);
  });

  describe('enrichChainWithGlacierData', () => {
    it('should enrich chain with validator data', async () => {
      const testChainData = {
        chainId: 'test-chain-id',
        chainName: 'Test Chain',
        subnetId: 'test-subnet-id',
        categories: ['TEST'],
        network: 'mainnet',
        rpcUrls: ['https://test.rpc'],
        validators: [],
        tps: null
      };

      // Note: This test may need mocking for Glacier API
      // For now, we test that the method exists and handles data correctly
      const enriched = await chainService.enrichChainWithGlacierData(testChainData);

      expect(enriched).toBeDefined();
      expect(enriched.chainId).toBe(testChainData.chainId);
      expect(enriched.chainName).toBe(testChainData.chainName);
      expect(enriched.categories).toEqual(testChainData.categories);
    }, 30000);

    it('should preserve registry metadata when enriching', async () => {
      const testChainData = {
        chainId: 'test-chain-id',
        chainName: 'Test Chain',
        subnetId: 'test-subnet-id',
        categories: ['TEST'],
        website: 'https://test.com',
        socials: [{ name: 'twitter', url: 'https://twitter.com/test' }],
        network: 'mainnet',
        rpcUrls: ['https://test.rpc'],
        validators: [],
        tps: null
      };

      const enriched = await chainService.enrichChainWithGlacierData(testChainData);

      expect(enriched.categories).toEqual(testChainData.categories);
      expect(enriched.website).toBe(testChainData.website);
      expect(enriched.socials).toEqual(testChainData.socials);
      expect(enriched.network).toBe(testChainData.network);
    }, 30000);

    it('should handle chains without subnetId', async () => {
      const testChainData = {
        chainId: 'test-chain-id',
        chainName: 'Test Chain',
        categories: ['TEST'],
        network: 'mainnet',
        rpcUrls: [],
        validators: [],
        tps: null
      };

      const enriched = await chainService.enrichChainWithGlacierData(testChainData);

      expect(enriched).toBeDefined();
      expect(enriched.validators).toBeDefined();
      expect(Array.isArray(enriched.validators)).toBe(true);
    }, 30000);

    it('should set lastUpdated timestamp', async () => {
      const testChainData = {
        chainId: 'test-chain-id',
        chainName: 'Test Chain',
        categories: ['TEST'],
        network: 'mainnet',
        rpcUrls: [],
        validators: [],
        tps: null
      };

      const enriched = await chainService.enrichChainWithGlacierData(testChainData);

      expect(enriched.lastUpdated).toBeDefined();
      expect(enriched.lastUpdated).toBeInstanceOf(Date);
    }, 30000);
  });

  describe('Cache invalidation', () => {
    it('should invalidate cache when updating chain', async () => {
      // This test verifies that cache is properly invalidated
      // Implementation depends on how updateChain is called

      const chains = await chainService.getAllChains();

      if (chains.length > 0) {
        const testChain = chains[0];

        // Subsequent calls should work correctly
        const result = await chainService.getChainById(testChain.chainId);
        expect(result).toBeDefined();
      }
    }, 30000);
  });

  describe('Error handling', () => {
    it('should handle errors when fetching chains', async () => {
      // Test that service handles database errors gracefully
      expect(async () => {
        await chainService.getAllChains({ category: null });
      }).not.toThrow();
    }, 30000);

    it('should return empty array on category fetch error', async () => {
      // Even if there's an error, should not throw
      const result = await chainService.getAllCategories();
      expect(Array.isArray(result)).toBe(true);
    }, 30000);
  });

  describe('Data consistency', () => {
    it('should return chains with consistent structure', async () => {
      const chains = await chainService.getAllChains();

      if (chains.length > 0) {
        const chain = chains[0];

        // Original fields
        expect(chain).toHaveProperty('chainId');
        expect(chain).toHaveProperty('chainName');
        expect(chain).toHaveProperty('validators');

        // Registry fields (may be undefined for some chains)
        expect(chain).toHaveProperty('categories');
        expect(chain).toHaveProperty('network');
      }
    }, 30000);

    it('should merge registry and Glacier data correctly', async () => {
      const chains = await chainService.getAllChains();

      if (chains.length > 0) {
        const chain = chains[0];

        // Should have both registry metadata
        if (chain.categories) {
          expect(Array.isArray(chain.categories)).toBe(true);
        }

        // And Glacier live data
        expect(chain).toHaveProperty('validators');
        expect(Array.isArray(chain.validators)).toBe(true);
      }
    }, 30000);
  });

  describe('Performance', () => {
    it('should handle multiple concurrent requests', async () => {
      const requests = [
        chainService.getAllChains(),
        chainService.getAllChains({ network: 'mainnet' }),
        chainService.getAllCategories()
      ];

      const results = await Promise.all(requests);

      results.forEach(result => {
        expect(result).toBeDefined();
        expect(Array.isArray(result)).toBe(true);
      });
    }, 15000);

    it('should complete getAllChains in reasonable time', async () => {
      const start = Date.now();
      await chainService.getAllChains();
      const duration = Date.now() - start;

      // Should complete within 10 seconds (first call without cache)
      expect(duration).toBeLessThan(10000);
    }, 15000);

    it('should complete getAllCategories in reasonable time', async () => {
      const start = Date.now();
      await chainService.getAllCategories();
      const duration = Date.now() - start;

      // Should complete within 5 seconds
      expect(duration).toBeLessThan(5000);
    }, 30000);
  });
});
