const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const REGISTRY_PATH = path.join(__dirname, '../../l1-registry/data');

class RegistryService {
  constructor() {
    this.chains = [];
    this.categories = new Set();
  }

  async loadAllChains() {
    try {
      logger.info('Loading chains from l1-registry...');

      if (!fs.existsSync(REGISTRY_PATH)) {
        throw new Error(`Registry path not found: ${REGISTRY_PATH}`);
      }

      const folders = fs.readdirSync(REGISTRY_PATH, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .filter(dirent => !dirent.name.startsWith('.') && !dirent.name.startsWith('_'))
        .map(dirent => dirent.name);

      logger.info(`Found ${folders.length} chain folders in registry`);

      const chains = [];

      for (const folder of folders) {
        try {
          const chainJsonPath = path.join(REGISTRY_PATH, folder, 'chain.json');

          if (!fs.existsSync(chainJsonPath)) {
            logger.warn(`Skipping ${folder}: chain.json not found`);
            continue;
          }

          const rawData = fs.readFileSync(chainJsonPath, 'utf8');
          const registryData = JSON.parse(rawData);

          const parsedChains = this.parseRegistryChain(registryData, folder);
          chains.push(...parsedChains);

          if (registryData.categories) {
            registryData.categories.forEach(cat => this.categories.add(cat));
          }
        } catch (error) {
          logger.error(`Error loading chain from ${folder}:`, error.message);
        }
      }

      this.chains = chains;
      logger.info(`Successfully loaded ${chains.length} chains from registry`);
      logger.info(`Found ${this.categories.size} unique categories`);

      return chains;
    } catch (error) {
      logger.error('Error loading registry:', error);
      throw error;
    }
  }

  parseRegistryChain(registryData, folderName) {
    const chains = [];

    if (!registryData.chains || registryData.chains.length === 0) {
      logger.warn(`No chains array found for ${folderName}`);
      return chains;
    }

    for (const chainData of registryData.chains) {
      const parsed = {
        chainId: chainData.blockchainId,
        blockchainId: chainData.blockchainId,
        chainName: chainData.name || registryData.name,
        chainLogoUri: registryData.logo,
        description: chainData.description || registryData.description,

        subnetId: registryData.subnetId,
        platformChainId: chainData.blockchainId,

        categories: registryData.categories || [],
        website: registryData.website,
        socials: registryData.socials || [],
        network: registryData.network,

        evmChainId: chainData.evmChainId,
        vmName: chainData.vmName,
        vmId: chainData.vmId,

        rpcUrls: chainData.rpcUrls || [],
        rpcUrl: chainData.rpcUrls && chainData.rpcUrls.length > 0
          ? chainData.rpcUrls[0]
          : undefined,

        assets: chainData.assets || [],

        registryMetadata: {
          folderName: folderName,
          lastUpdated: new Date(),
          source: 'l1-registry'
        },

        tps: null,
        validators: [],
        cumulativeTxCount: null,
      };

      chains.push(parsed);
    }

    return chains;
  }

  getChainBySubnetId(subnetId) {
    return this.chains.find(chain => chain.subnetId === subnetId);
  }

  getChainByBlockchainId(blockchainId) {
    return this.chains.find(chain => chain.blockchainId === blockchainId);
  }

  getChainsByCategory(category) {
    return this.chains.filter(chain =>
      chain.categories && chain.categories.includes(category)
    );
  }

  getChainsByNetwork(network) {
    return this.chains.filter(chain => chain.network === network);
  }

  getAllCategories() {
    return Array.from(this.categories).sort();
  }

  getChainCount() {
    return this.chains.length;
  }

  async syncToDatabase(Chain) {
    try {
      logger.info('Syncing registry data to database...');

      let syncedCount = 0;
      let errorCount = 0;
      let mergedCount = 0;
      let newCount = 0;

      for (const chainData of this.chains) {
        try {
          // Find existing Glacier chain to merge into
          // Glacier chains use numeric chainId (e.g., "43114") but don't have evmChainId field
          // Registry chains have evmChainId that matches Glacier's chainId
          let existingChain = null;

          if (chainData.evmChainId) {
            // Look for Glacier chain where chainId matches registry's evmChainId
            // AND chain doesn't already have blockchainId (meaning it's a pure Glacier chain)
            existingChain = await Chain.findOne({
              chainId: String(chainData.evmChainId),
              blockchainId: { $exists: false }
            });
          }

          // If no match by evmChainId->chainId, try blockchainId for registry-only chains
          if (!existingChain) {
            existingChain = await Chain.findOne({
              blockchainId: chainData.blockchainId
            });
          }

          if (existingChain) {
            // Debug logging for C-Chain
            if (chainData.chainName === 'C-Chain') {
              logger.info(`[DEBUG] Merging C-Chain:`, {
                existingChainId: existingChain.chainId,
                registryEvmChainId: chainData.evmChainId,
                registryCategories: chainData.categories,
                registryNetwork: chainData.network,
                registryRpcUrls: chainData.rpcUrls
              });
            }

            // Merge into existing Glacier chain
            // Keep Glacier's numeric chainId, add registry metadata
            const updated = await Chain.findOneAndUpdate(
              { _id: existingChain._id },
              {
                $set: {
                  // Keep existing chainId from Glacier (numeric)
                  // Add blockchainId from registry
                  blockchainId: chainData.blockchainId,

                  // Update basic info if registry has better data
                  chainName: chainData.chainName,
                  chainLogoUri: chainData.chainLogoUri,
                  description: chainData.description,
                  subnetId: chainData.subnetId,
                  platformChainId: chainData.platformChainId,

                  // Add registry metadata
                  categories: chainData.categories,
                  website: chainData.website,
                  socials: chainData.socials,
                  network: chainData.network,

                  evmChainId: chainData.evmChainId,
                  vmName: chainData.vmName,
                  vmId: chainData.vmId,

                  rpcUrls: chainData.rpcUrls,
                  rpcUrl: chainData.rpcUrl,

                  assets: chainData.assets,
                  registryMetadata: chainData.registryMetadata,
                }
              },
              { new: true }
            );

            // Debug logging for C-Chain after update
            if (chainData.chainName === 'C-Chain') {
              logger.info(`[DEBUG] C-Chain after update:`, {
                chainId: updated.chainId,
                blockchainId: updated.blockchainId,
                categories: updated.categories,
                network: updated.network,
                rpcUrls: updated.rpcUrls?.length
              });
            }

            mergedCount++;
          } else {
            // No existing chain found - create new from registry
            await Chain.findOneAndUpdate(
              { blockchainId: chainData.blockchainId },
              {
                $set: {
                  chainId: chainData.chainId,
                  blockchainId: chainData.blockchainId,
                  chainName: chainData.chainName,
                  chainLogoUri: chainData.chainLogoUri,
                  description: chainData.description,
                  subnetId: chainData.subnetId,
                  platformChainId: chainData.platformChainId,

                  categories: chainData.categories,
                  website: chainData.website,
                  socials: chainData.socials,
                  network: chainData.network,

                  evmChainId: chainData.evmChainId,
                  vmName: chainData.vmName,
                  vmId: chainData.vmId,

                  rpcUrls: chainData.rpcUrls,
                  rpcUrl: chainData.rpcUrl,

                  assets: chainData.assets,
                  registryMetadata: chainData.registryMetadata,
                }
              },
              {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true
              }
            );
            newCount++;
          }
          syncedCount++;
        } catch (error) {
          logger.error(`Error syncing chain ${chainData.chainName}:`, {
            message: error.message,
            stack: error.stack
          });
          errorCount++;
        }
      }

      logger.info(`Registry sync complete: ${syncedCount} chains synced (${mergedCount} merged, ${newCount} new), ${errorCount} errors`);
      return { syncedCount, mergedCount, newCount, errorCount };
    } catch (error) {
      logger.error('Error syncing registry to database:', error);
      throw error;
    }
  }
}

module.exports = new RegistryService();
