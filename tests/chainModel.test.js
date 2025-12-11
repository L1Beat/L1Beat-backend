/**
 * Chain Model Tests
 * Tests the Chain MongoDB model with new registry fields
 */

const Chain = require('../src/models/chain');
const mongoose = require('mongoose');

describe('Chain Model', () => {
  describe('Schema validation', () => {
    it('should create a chain with required fields', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain'
      };

      const chain = new Chain(chainData);

      expect(chain.subnetId).toBe(chainData.subnetId);
      expect(chain.blockchainId).toBe(chainData.blockchainId);
      expect(chain.chainName).toBe(chainData.chainName);
    });

    it('should accept new registry fields', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'blockchain-id-123',
        chainName: 'Test Chain',
        categories: ['DeFi', 'Gaming'],
        website: 'https://testchain.com',
        socials: [
          { name: 'twitter', url: 'https://twitter.com/testchain' },
          { name: 'discord', url: 'https://discord.gg/testchain' }
        ],
        network: 'mainnet',
        evmChainId: 12345,
        rpcUrls: ['https://rpc1.testchain.com', 'https://rpc2.testchain.com'],
        assets: [
          { symbol: 'TEST', name: 'Test Token', decimals: 18 }
        ],
        registryMetadata: {
          folderName: 'test-chain',
          lastUpdated: new Date(),
          source: 'l1-registry'
        }
      };

      const chain = new Chain(chainData);

      expect(chain.categories).toEqual(chainData.categories);
      expect(chain.website).toBe(chainData.website);
      // MongoDB adds _id to subdocuments, so we check the essential fields
      expect(chain.socials.length).toBe(chainData.socials.length);
      expect(chain.socials[0].name).toBe(chainData.socials[0].name);
      expect(chain.socials[0].url).toBe(chainData.socials[0].url);
      expect(chain.socials[1].name).toBe(chainData.socials[1].name);
      expect(chain.socials[1].url).toBe(chainData.socials[1].url);
      expect(chain.network).toBe(chainData.network);
      expect(chain.evmChainId).toBe(chainData.evmChainId);
      expect(chain.rpcUrls).toEqual(chainData.rpcUrls);
      // MongoDB adds _id to subdocuments, so we check the essential fields
      expect(chain.assets.length).toBe(chainData.assets.length);
      expect(chain.assets[0].symbol).toBe(chainData.assets[0].symbol);
      expect(chain.assets[0].name).toBe(chainData.assets[0].name);
      expect(chain.assets[0].decimals).toBe(chainData.assets[0].decimals);
      expect(chain.registryMetadata).toBeDefined();
    });

    it('should validate network enum values', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        network: 'invalid-network'
      };

      const chain = new Chain(chainData);

      // Should fail validation with invalid enum value
      const validationError = chain.validateSync();
      expect(validationError).toBeDefined();
      expect(validationError.errors.network).toBeDefined();
    });

    it('should accept null network value', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        network: null
      };

      const chain = new Chain(chainData);
      const validationError = chain.validateSync();

      expect(validationError).toBeUndefined();
      expect(chain.network).toBeNull();
    });

    it('should accept mainnet network value', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        network: 'mainnet'
      };

      const chain = new Chain(chainData);
      const validationError = chain.validateSync();

      expect(validationError).toBeUndefined();
      expect(chain.network).toBe('mainnet');
    });

    it('should accept fuji network value', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        network: 'fuji'
      };

      const chain = new Chain(chainData);
      const validationError = chain.validateSync();

      expect(validationError).toBeUndefined();
      expect(chain.network).toBe('fuji');
    });

    it('should store categories as array', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        categories: ['DeFi', 'NFT', 'Gaming']
      };

      const chain = new Chain(chainData);

      expect(Array.isArray(chain.categories)).toBe(true);
      expect(chain.categories.length).toBe(3);
      expect(chain.categories).toContain('DeFi');
      expect(chain.categories).toContain('NFT');
      expect(chain.categories).toContain('Gaming');
    });

    it('should store socials as array of objects', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        socials: [
          { name: 'twitter', url: 'https://twitter.com/test' },
          { name: 'discord', url: 'https://discord.gg/test' },
          { name: 'telegram', url: 'https://t.me/test' }
        ]
      };

      const chain = new Chain(chainData);

      expect(Array.isArray(chain.socials)).toBe(true);
      expect(chain.socials.length).toBe(3);

      chain.socials.forEach(social => {
        expect(social).toHaveProperty('name');
        expect(social).toHaveProperty('url');
      });
    });

    it('should store rpcUrls as array', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        rpcUrls: ['https://rpc1.test.com', 'https://rpc2.test.com', 'https://rpc3.test.com']
      };

      const chain = new Chain(chainData);

      expect(Array.isArray(chain.rpcUrls)).toBe(true);
      expect(chain.rpcUrls.length).toBe(3);
    });

    it('should store assets with correct structure', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        assets: [
          { symbol: 'TOKEN1', name: 'Token One', decimals: 18 },
          { symbol: 'TOKEN2', name: 'Token Two', decimals: 6 }
        ]
      };

      const chain = new Chain(chainData);

      expect(Array.isArray(chain.assets)).toBe(true);
      expect(chain.assets.length).toBe(2);

      chain.assets.forEach(asset => {
        expect(asset).toHaveProperty('symbol');
        expect(asset).toHaveProperty('name');
        expect(asset).toHaveProperty('decimals');
        expect(typeof asset.symbol).toBe('string');
        expect(typeof asset.name).toBe('string');
        expect(typeof asset.decimals).toBe('number');
      });
    });

    it('should preserve existing fields alongside new registry fields', () => {
      const chainData = {
        // Existing fields - subnetId is required
        subnetId: 'subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        status: 'active',
        description: 'Test chain description',
        platformChainId: 'platform-123',
        vmId: 'vm-123',
        vmName: 'EVM',
        explorerUrl: 'https://explorer.test.com',
        rpcUrl: 'https://rpc.test.com',
        wsUrl: 'wss://ws.test.com',
        isTestnet: false,
        validators: [],

        // New registry fields
        categories: ['DeFi'],
        website: 'https://test.com',
        network: 'mainnet',
        evmChainId: 12345,
        rpcUrls: ['https://rpc.test.com']
      };

      const chain = new Chain(chainData);

      // Existing fields should still work
      expect(chain.blockchainId).toBe(chainData.blockchainId);
      expect(chain.status).toBe(chainData.status);
      expect(chain.vmName).toBe(chainData.vmName);
      expect(chain.explorerUrl).toBe(chainData.explorerUrl);

      // New registry fields should work
      expect(chain.categories).toEqual(chainData.categories);
      expect(chain.website).toBe(chainData.website);
      expect(chain.network).toBe(chainData.network);
      expect(chain.evmChainId).toBe(chainData.evmChainId);
    });
  });

  describe('Model indexes', () => {
    it('should have index on blockchainId', () => {
      const indexes = Chain.schema.indexes();
      // blockchainId has unique: true which creates an index
      const blockchainIdIndex = indexes.find(idx => idx[0].blockchainId);
      expect(blockchainIdIndex).toBeDefined();
    });

    it('should have index on categories', () => {
      const indexes = Chain.schema.indexes();
      const categoriesIndex = indexes.find(idx => idx[0].categories);

      expect(categoriesIndex).toBeDefined();
    });

    it('should have index on network', () => {
      const indexes = Chain.schema.indexes();
      const networkIndex = indexes.find(idx => idx[0].network);

      expect(networkIndex).toBeDefined();
    });

    it('should have index on subnetId', () => {
      const indexes = Chain.schema.indexes();
      const subnetIdIndex = indexes.find(idx => idx[0].subnetId);

      expect(subnetIdIndex).toBeDefined();
    });
  });

  describe('Model methods', () => {
    it('should convert to object with toObject()', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        categories: ['DeFi'],
        network: 'mainnet'
      };

      const chain = new Chain(chainData);
      const chainObj = chain.toObject();

      expect(typeof chainObj).toBe('object');
      expect(chainObj.blockchainId).toBe(chainData.blockchainId);
      expect(chainObj.categories).toEqual(chainData.categories);
      expect(chainObj.network).toBe(chainData.network);
    });

    it('should convert to JSON with toJSON()', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        categories: ['DeFi'],
        website: 'https://test.com',
        network: 'mainnet'
      };

      const chain = new Chain(chainData);
      const chainJson = JSON.parse(JSON.stringify(chain));

      expect(chainJson.blockchainId).toBe(chainData.blockchainId);
      expect(chainJson.categories).toEqual(chainData.categories);
      expect(chainJson.website).toBe(chainData.website);
    });
  });

  describe('Default values', () => {
    it('should set default lastUpdated', () => {
      const chain = new Chain({
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain'
      });

      expect(chain.lastUpdated).toBeDefined();
      expect(chain.lastUpdated).toBeInstanceOf(Date);
    });

    it('should allow undefined for optional registry fields', () => {
      const chain = new Chain({
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain'
      });

      // Mongoose defaults array fields to empty arrays, not undefined
      expect(Array.isArray(chain.categories)).toBe(true);
      expect(chain.categories.length).toBe(0);
      expect(chain.website).toBeUndefined();
      expect(Array.isArray(chain.socials)).toBe(true);
      expect(chain.socials.length).toBe(0);
      expect(chain.network).toBeNull();
      expect(chain.evmChainId).toBeUndefined();
    });
  });

  describe('Field types', () => {
    it('should accept blockchainId as string', () => {
      const chain = new Chain({
        subnetId: 'test-subnet-123',
        blockchainId: 'blockchain-abc-123',
        chainName: 'Test Chain'
      });

      expect(typeof chain.blockchainId).toBe('string');
      expect(chain.blockchainId).toBe('blockchain-abc-123');
    });

    it('should accept evmChainId as number', () => {
      const chain = new Chain({
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        evmChainId: 43114
      });

      expect(typeof chain.evmChainId).toBe('number');
      expect(chain.evmChainId).toBe(43114);
    });

    it('should accept website as string', () => {
      const chain = new Chain({
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        website: 'https://testchain.io'
      });

      expect(typeof chain.website).toBe('string');
      expect(chain.website).toBe('https://testchain.io');
    });
  });

  describe('Backward compatibility', () => {
    it('should work with existing chain data without registry fields', () => {
      const oldChainData = {
        blockchainId: 'old-blockchain-123',
        status: 'active',
        chainName: 'Old Chain',
        description: 'Old chain without registry data',
        platformChainId: 'platform-123',
        subnetId: 'subnet-123',
        vmId: 'vm-123',
        vmName: 'EVM',
        explorerUrl: 'https://explorer.old.com',
        rpcUrl: 'https://rpc.old.com',
        validators: []
      };

      const chain = new Chain(oldChainData);

      expect(chain.blockchainId).toBe(oldChainData.blockchainId);
      expect(chain.chainName).toBe(oldChainData.chainName);
      expect(chain.validators).toEqual(oldChainData.validators);

      // Registry array fields default to empty arrays in Mongoose
      expect(Array.isArray(chain.categories)).toBe(true);
      expect(chain.categories.length).toBe(0);
      expect(chain.website).toBeUndefined();
      expect(chain.network).toBeNull();
    });

    it('should maintain existing TPS and cumulativeTxCount structure', () => {
      const chainData = {
        subnetId: 'test-subnet-123',
        blockchainId: 'test-blockchain-123',
        chainName: 'Test Chain',
        tps: {
          value: 100.5,
          timestamp: Date.now(),
          lastUpdated: new Date()
        },
        cumulativeTxCount: {
          value: 1000000,
          timestamp: Date.now(),
          lastUpdated: new Date()
        }
      };

      const chain = new Chain(chainData);

      expect(chain.tps).toBeDefined();
      expect(chain.tps.value).toBe(chainData.tps.value);
      expect(chain.cumulativeTxCount).toBeDefined();
      expect(chain.cumulativeTxCount.value).toBe(chainData.cumulativeTxCount.value);
    });
  });
});
