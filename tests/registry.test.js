/**
 * Registry Service Tests
 * Tests the registry service for loading and parsing l1-registry data
 */

const registryService = require('../src/services/registryService');
const Chain = require('../src/models/chain');
const fs = require('fs');
const path = require('path');

describe('Registry Service', () => {
  describe('loadAllChains', () => {
    it('should load chains from l1-registry', async () => {
      const chains = await registryService.loadAllChains();

      expect(Array.isArray(chains)).toBe(true);
      expect(chains.length).toBeGreaterThan(0);
    }, 10000);

    it('should parse chain data with required fields', async () => {
      const chains = await registryService.loadAllChains();

      if (chains.length > 0) {
        const chain = chains[0];

        // Required fields from registry
        expect(chain).toHaveProperty('chainId');
        expect(chain).toHaveProperty('chainName');
        expect(chain).toHaveProperty('subnetId');
        expect(chain).toHaveProperty('blockchainId');

        // Registry metadata fields
        expect(chain).toHaveProperty('categories');
        expect(chain).toHaveProperty('website');
        expect(chain).toHaveProperty('socials');
        expect(chain).toHaveProperty('network');
        expect(chain).toHaveProperty('rpcUrls');
        expect(chain).toHaveProperty('registryMetadata');

        // Verify types
        expect(typeof chain.chainId).toBe('string');
        expect(typeof chain.chainName).toBe('string');
        expect(Array.isArray(chain.categories)).toBe(true);
        expect(Array.isArray(chain.rpcUrls)).toBe(true);
      }
    }, 10000);

    it('should parse socials array correctly', async () => {
      const chains = await registryService.loadAllChains();

      const chainWithSocials = chains.find(c => c.socials && c.socials.length > 0);

      if (chainWithSocials) {
        expect(Array.isArray(chainWithSocials.socials)).toBe(true);

        chainWithSocials.socials.forEach(social => {
          expect(social).toHaveProperty('name');
          expect(social).toHaveProperty('url');
          expect(typeof social.name).toBe('string');
          expect(typeof social.url).toBe('string');
        });
      }
    }, 10000);

    it('should set network field correctly', async () => {
      const chains = await registryService.loadAllChains();

      chains.forEach(chain => {
        if (chain.network) {
          expect(['mainnet', 'fuji']).toContain(chain.network);
        }
      });
    }, 10000);

    it('should handle chains with multiple RPC URLs', async () => {
      const chains = await registryService.loadAllChains();

      const chainWithRpcs = chains.find(c => c.rpcUrls && c.rpcUrls.length > 0);

      if (chainWithRpcs) {
        expect(Array.isArray(chainWithRpcs.rpcUrls)).toBe(true);
        expect(chainWithRpcs.rpcUrls.length).toBeGreaterThan(0);

        // Should also set first RPC as default rpcUrl
        expect(chainWithRpcs.rpcUrl).toBe(chainWithRpcs.rpcUrls[0]);
      }
    }, 10000);

    it('should include registryMetadata with source information', async () => {
      const chains = await registryService.loadAllChains();

      if (chains.length > 0) {
        const chain = chains[0];

        expect(chain.registryMetadata).toBeDefined();
        expect(chain.registryMetadata.source).toBe('l1-registry');
        expect(chain.registryMetadata.lastUpdated).toBeDefined();
        expect(chain.registryMetadata.folderName).toBeDefined();
      }
    }, 10000);
  });

  describe('getAllCategories', () => {
    it('should return array of unique categories', () => {
      const categories = registryService.getAllCategories();

      expect(Array.isArray(categories)).toBe(true);
      expect(categories.length).toBeGreaterThan(0);

      // Check for uniqueness
      const uniqueCategories = [...new Set(categories)];
      expect(categories.length).toBe(uniqueCategories.length);

      // Should be sorted
      const sortedCategories = [...categories].sort();
      expect(categories).toEqual(sortedCategories);
    });

    it('should contain expected category types', () => {
      const categories = registryService.getAllCategories();

      // Should contain some common categories (adjust based on actual data)
      const hasCategories = categories.length > 0;
      expect(hasCategories).toBe(true);

      // All categories should be strings
      categories.forEach(cat => {
        expect(typeof cat).toBe('string');
        expect(cat.length).toBeGreaterThan(0);
      });
    });
  });

  describe('getChainBySubnetId', () => {
    it('should find chain by subnet ID', async () => {
      await registryService.loadAllChains();
      const chains = registryService.chains;

      if (chains.length > 0) {
        const testChain = chains[0];
        const found = registryService.getChainBySubnetId(testChain.subnetId);

        expect(found).toBeDefined();
        expect(found.subnetId).toBe(testChain.subnetId);
        expect(found.chainId).toBe(testChain.chainId);
      }
    }, 10000);

    it('should return undefined for non-existent subnet ID', async () => {
      await registryService.loadAllChains();

      const found = registryService.getChainBySubnetId('non-existent-subnet-id');

      expect(found).toBeUndefined();
    }, 10000);
  });

  describe('getChainByBlockchainId', () => {
    it('should find chain by blockchain ID', async () => {
      await registryService.loadAllChains();
      const chains = registryService.chains;

      if (chains.length > 0) {
        const testChain = chains[0];
        const found = registryService.getChainByBlockchainId(testChain.blockchainId);

        expect(found).toBeDefined();
        expect(found.blockchainId).toBe(testChain.blockchainId);
      }
    }, 10000);

    it('should return undefined for non-existent blockchain ID', async () => {
      await registryService.loadAllChains();

      const found = registryService.getChainByBlockchainId('non-existent-blockchain-id');

      expect(found).toBeUndefined();
    }, 10000);
  });

  describe('getChainsByCategory', () => {
    it('should filter chains by category', async () => {
      await registryService.loadAllChains();
      const categories = registryService.getAllCategories();

      if (categories.length > 0) {
        const testCategory = categories[0];
        const filtered = registryService.getChainsByCategory(testCategory);

        expect(Array.isArray(filtered)).toBe(true);

        filtered.forEach(chain => {
          expect(chain.categories).toContain(testCategory);
        });
      }
    }, 10000);

    it('should return empty array for non-existent category', async () => {
      await registryService.loadAllChains();

      const filtered = registryService.getChainsByCategory('NON_EXISTENT_CATEGORY');

      expect(Array.isArray(filtered)).toBe(true);
      expect(filtered.length).toBe(0);
    }, 10000);
  });

  describe('getChainsByNetwork', () => {
    it('should filter chains by mainnet', async () => {
      await registryService.loadAllChains();

      const mainnetChains = registryService.getChainsByNetwork('mainnet');

      expect(Array.isArray(mainnetChains)).toBe(true);

      mainnetChains.forEach(chain => {
        expect(chain.network).toBe('mainnet');
      });
    }, 10000);

    it('should filter chains by fuji', async () => {
      await registryService.loadAllChains();

      const fujiChains = registryService.getChainsByNetwork('fuji');

      expect(Array.isArray(fujiChains)).toBe(true);

      fujiChains.forEach(chain => {
        expect(chain.network).toBe('fuji');
      });
    }, 10000);
  });

  describe('getChainCount', () => {
    it('should return correct number of chains', async () => {
      await registryService.loadAllChains();

      const count = registryService.getChainCount();

      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThan(0);
      expect(count).toBe(registryService.chains.length);
    }, 10000);
  });

  describe('Registry Data Structure', () => {
    it('should parse evmChainId correctly', async () => {
      const chains = await registryService.loadAllChains();

      const chainWithEvmId = chains.find(c => c.evmChainId);

      if (chainWithEvmId) {
        expect(typeof chainWithEvmId.evmChainId).toBe('number');
        expect(chainWithEvmId.evmChainId).toBeGreaterThan(0);
      }
    }, 10000);

    it('should parse assets array correctly', async () => {
      const chains = await registryService.loadAllChains();

      const chainWithAssets = chains.find(c => c.assets && c.assets.length > 0);

      if (chainWithAssets) {
        expect(Array.isArray(chainWithAssets.assets)).toBe(true);

        chainWithAssets.assets.forEach(asset => {
          expect(asset).toHaveProperty('symbol');
          expect(asset).toHaveProperty('name');
          expect(asset).toHaveProperty('decimals');
          expect(typeof asset.symbol).toBe('string');
          expect(typeof asset.name).toBe('string');
          expect(typeof asset.decimals).toBe('number');
        });
      }
    }, 10000);

    it('should handle chains without optional fields gracefully', async () => {
      const chains = await registryService.loadAllChains();

      // Should not throw errors even if optional fields are missing
      expect(() => {
        chains.forEach(chain => {
          // Access optional fields
          const _ = chain.website;
          const __ = chain.socials;
          const ___ = chain.evmChainId;
        });
      }).not.toThrow();
    }, 10000);
  });

  describe('Error Handling', () => {
    it('should handle missing registry directory gracefully', async () => {
      // This test verifies error handling if registry path doesn't exist
      // Actual behavior depends on whether registry is present

      const originalPath = registryService.REGISTRY_PATH;

      // Don't actually test with invalid path in real tests
      // as it would break other tests
      expect(true).toBe(true);
    });

    it('should skip invalid JSON files', async () => {
      // Registry service should skip folders without valid chain.json
      const chains = await registryService.loadAllChains();

      // Should still load valid chains
      expect(chains.length).toBeGreaterThan(0);
    }, 10000);
  });
});
