/**
 * Debug Registry Sync
 *
 * Comprehensive diagnostics for registry loading and C-Chain sync
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const registryService = require('../src/services/registryService');
const logger = require('../src/utils/logger');
const fs = require('fs');
const path = require('path');

async function main() {
  try {
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    logger.info('=== REGISTRY SYNC DIAGNOSTICS ===\n');

    // 1. Check what folders exist
    logger.info('1. Checking l1-registry folders...');
    const registryPath = path.join(__dirname, '../l1-registry/data');
    const folders = fs.readdirSync(registryPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .filter(dirent => !dirent.name.startsWith('.') && !dirent.name.startsWith('_'))
      .map(dirent => dirent.name);

    logger.info(`   Found ${folders.length} folders:`);
    folders.forEach(f => logger.info(`   - ${f}`));

    // 2. Check if avalanche-c-chain exists
    const avalancheFolder = folders.find(f => f.includes('avalanche'));
    if (avalancheFolder) {
      logger.info(`\n2. Found Avalanche folder: ${avalancheFolder}`);
      const chainJsonPath = path.join(registryPath, avalancheFolder, 'chain.json');
      if (fs.existsSync(chainJsonPath)) {
        const chainData = JSON.parse(fs.readFileSync(chainJsonPath, 'utf8'));
        logger.info(`   SubnetId: ${chainData.subnetId}`);
        logger.info(`   Chains in array: ${chainData.chains.length}`);
        chainData.chains.forEach((chain, idx) => {
          logger.info(`   Chain ${idx + 1}: ${chain.name} (evmChainId: ${chain.evmChainId})`);
        });
      }
    } else {
      logger.warn('\n2. No Avalanche folder found!');
    }

    // 3. Load chains from registry
    logger.info('\n3. Loading chains from registry...');
    const chains = await registryService.loadAllChains();
    logger.info(`   Loaded ${chains.length} chains total`);

    // 4. Find C-Chain in loaded data
    const cChain = chains.find(c =>
      c.evmChainId === 43114 ||
      c.chainName.toLowerCase().includes('c-chain')
    );

    if (cChain) {
      logger.info('\n4. ✅ C-Chain FOUND in registry data:');
      logger.info(`   Name: ${cChain.chainName}`);
      logger.info(`   SubnetId: ${cChain.subnetId}`);
      logger.info(`   BlockchainId: ${cChain.blockchainId}`);
      logger.info(`   EvmChainId: ${cChain.evmChainId}`);
      logger.info(`   Folder: ${cChain.registryMetadata.folderName}`);
    } else {
      logger.warn('\n4. ❌ C-Chain NOT found in loaded registry data');
    }

    // 5. Connect to database
    logger.info('\n5. Connecting to database...');
    await mongoose.connect(dbUri);
    logger.info('   Connected');

    // 6. Check if C-Chain already exists in database
    const dbCChain = await Chain.findOne({
      $or: [
        { evmChainId: 43114 },
        { chainName: /c-chain/i }
      ]
    });

    if (dbCChain) {
      logger.info('\n6. C-Chain already in database:');
      logger.info(`   Name: ${dbCChain.chainName}`);
      logger.info(`   SubnetId: ${dbCChain.subnetId}`);
      logger.info(`   EvmChainId: ${dbCChain.evmChainId}`);
    } else {
      logger.info('\n6. C-Chain NOT in database');
    }

    // 7. Sync registry to database
    logger.info('\n7. Syncing registry to database...');
    const result = await registryService.syncToDatabase(Chain);
    logger.info(`   Synced: ${result.syncedCount}, Errors: ${result.errorCount}`);

    // 8. Check if C-Chain is now in database
    const dbCChainAfter = await Chain.findOne({
      $or: [
        { evmChainId: 43114 },
        { chainName: /c-chain/i }
      ]
    });

    if (dbCChainAfter) {
      logger.info('\n8. ✅ C-Chain NOW in database:');
      logger.info(`   Name: ${dbCChainAfter.chainName}`);
      logger.info(`   SubnetId: ${dbCChainAfter.subnetId}`);
      logger.info(`   BlockchainId: ${dbCChainAfter.blockchainId}`);
      logger.info(`   EvmChainId: ${dbCChainAfter.evmChainId}`);
    } else {
      logger.error('\n8. ❌ C-Chain STILL NOT in database after sync!');
    }

    // 9. Check primary network subnetId
    const primarySubnetId = '11111111111111111111111111111111LpoYY';
    const primaryChain = await Chain.findOne({ subnetId: primarySubnetId });

    if (primaryChain) {
      logger.info('\n9. Chain with primary network subnetId:');
      logger.info(`   Name: ${primaryChain.chainName}`);
      logger.info(`   EvmChainId: ${primaryChain.evmChainId}`);
      logger.info(`   This should be C-Chain (evmChainId: 43114)`);
    } else {
      logger.info('\n9. No chain with primary network subnetId found');
    }

    await mongoose.disconnect();
    logger.info('\n=== DIAGNOSTICS COMPLETE ===');
    process.exit(0);
  } catch (error) {
    logger.error('Error:', error);
    process.exit(1);
  }
}

main();
