/**
 * Sync Registry to Database
 *
 * Manually trigger a registry sync to load/update chains from l1-registry
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const registryService = require('../src/services/registryService');
const logger = require('../src/utils/logger');

async function main() {
  try {
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    logger.info('Connecting to database...');
    await mongoose.connect(dbUri);
    logger.info('Connected to database\n');

    // Load registry chains
    logger.info('Loading chains from l1-registry...');
    const chains = await registryService.loadAllChains();
    logger.info(`Loaded ${chains.length} chains from l1-registry\n`);

    // Sync to database
    logger.info('Syncing to database...');
    const result = await registryService.syncToDatabase(Chain);

    logger.info('\n=== Sync Complete ===');
    logger.info(`Synced: ${result.syncedCount}`);
    logger.info(`Upserted: ${result.newCount}`);
    logger.info(`Errors: ${result.errorCount}`);

    // Verify C-Chain
    logger.info('\n=== Verifying C-Chain ===');
    const cChain = await Chain.findOne({ chainName: /c-chain/i });
    if (cChain) {
      logger.info('✅ C-Chain found in database!');
      logger.info(`   Name: ${cChain.chainName}`);
      logger.info(`   SubnetId: ${cChain.subnetId}`);
      logger.info(`   EvmChainId: ${cChain.evmChainId}`);
    } else {
      logger.warn('⚠️  C-Chain not found');
    }

    // Total chains
    const total = await Chain.countDocuments();
    logger.info(`\nTotal chains in database: ${total}`);

    await mongoose.disconnect();
    logger.info('\nDisconnected from database');
    process.exit(0);
  } catch (error) {
    logger.error('Error:', error);
    process.exit(1);
  }
}

main();
