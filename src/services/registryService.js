const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const registry = require('l1beat-l1-registry');
const REGISTRY_PATH = registry.getDataPath();

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
        subnetId: registryData.subnetId,
        blockchainId: chainData.blockchainId,
        chainId: chainData.blockchainId,
        isL1: registryData.isL1,
        sybilResistanceType: chainData.sybilResistanceType,
        chainName: chainData.name || registryData.name,
        chainLogoUri: registryData.logo,
        description: chainData.description || registryData.description,

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

        explorerUrl: chainData.explorerUrl || undefined,

        nativeToken: {
          symbol: chainData.nativeToken?.symbol,
          name: chainData.nativeToken?.name,
          decimals: chainData.nativeToken?.decimals,
          logoUri: chainData.nativeToken?.logoUri
        },

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

  /**
   * A chain is the registry folder, not the subnet id. Subnet, blockchain, and
   * evm chain id all change when an L1 is redeployed (FRQTAL moved folders in
   * place). Match that folder and replace the old row instead of inserting a
   * second one keyed by the new subnet id.
   */
  async resolveSyncTarget(Chain, chainData) {
    const folderName = chainData.registryMetadata && chainData.registryMetadata.folderName;
    const folderDocs = folderName
      ? await Chain.find({
          'registryMetadata.folderName': folderName,
          'registryMetadata.source': 'l1-registry'
        })
      : [];

    const bySubnet = await Chain.findOne({ subnetId: chainData.subnetId });
    const registryCount = folderName
      ? this.chains.filter(chain => chain.registryMetadata
          && chain.registryMetadata.folderName === folderName).length
      : 0;

    const sameName = folderDocs.filter(doc => doc.chainName === chainData.chainName);
    let candidates = [];
    if (sameName.length > 0) {
      candidates = sameName;
    } else if (folderDocs.length === 1 && registryCount === 1) {
      candidates = folderDocs;
    }

    if (bySubnet && !candidates.some(doc => String(doc._id) === String(bySubnet._id))) {
      if (candidates.length === 0) candidates = [bySubnet];
    }

    if (candidates.length === 0) {
      return { target: null, duplicateIds: [] };
    }

    // Keep the row that already has validators, otherwise the pre-move row,
    // so a duplicate insert from an earlier subnet-id upsert does not win.
    const target = candidates.find(doc => Array.isArray(doc.validators) && doc.validators.length > 0)
      || candidates.find(doc => doc.subnetId !== chainData.subnetId)
      || candidates[0];

    const duplicateIds = [];
    const seen = new Set();
    const pushDuplicate = (doc) => {
      if (!doc || String(doc._id) === String(target._id)) return;
      const id = String(doc._id);
      if (seen.has(id)) return;
      seen.add(id);
      duplicateIds.push(doc._id);
    };
    candidates.forEach(pushDuplicate);
    pushDuplicate(bySubnet);

    return { target, duplicateIds };
  }

  async syncToDatabase(Chain) {
    try {
      logger.info('Syncing registry data to database...');

      let syncedCount = 0;
      let errorCount = 0;
      let mergedCount = 0;
      let newCount = 0;
      let replacedCount = 0;

      for (const chainData of this.chains) {
        try {
          const { target, duplicateIds } = await this.resolveSyncTarget(Chain, chainData);
          if (duplicateIds.length > 0) {
            await Chain.deleteMany({ _id: { $in: duplicateIds } });
            logger.info(`Removed ${duplicateIds.length} stale subnet row(s) for ${chainData.chainName}`, {
              folderName: chainData.registryMetadata && chainData.registryMetadata.folderName
            });
          }
          if (target && target.subnetId !== chainData.subnetId) {
            replacedCount++;
            logger.info(`Replacing moved chain ${chainData.chainName}`, {
              fromSubnet: target.subnetId,
              toSubnet: chainData.subnetId,
              evmChainId: chainData.evmChainId
            });
          }

          await Chain.findOneAndUpdate(
            target ? { _id: target._id } : { subnetId: chainData.subnetId },
            {
              $set: {
                subnetId: chainData.subnetId,
                isL1: chainData.isL1,
                sybilResistanceType: chainData.sybilResistanceType,
                blockchainId: chainData.blockchainId,
                chainId: chainData.chainId || chainData.blockchainId,
                chainName: chainData.chainName,
                chainLogoUri: chainData.chainLogoUri,
                description: chainData.description,
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

                explorerUrl: chainData.explorerUrl,

                nativeToken: chainData.nativeToken,
                registryMetadata: chainData.registryMetadata,
              },
              $setOnInsert: {
                tps: null,
                cumulativeTxCount: null,
                validators: []
              }
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true
            }
          );
          newCount++;
          syncedCount++;
        } catch (error) {
          logger.error(`Error syncing chain ${chainData.chainName}:`, {
            message: error.message,
            stack: error.stack
          });
          errorCount++;
        }
      }

      logger.info(`Registry sync complete: ${syncedCount} chains synced (${newCount} upserted, ${replacedCount} moved), ${errorCount} errors`);
      return { syncedCount, mergedCount, newCount, replacedCount, errorCount };
    } catch (error) {
      logger.error('Error syncing registry to database:', error);
      throw error;
    }
  }
}

module.exports = new RegistryService();
