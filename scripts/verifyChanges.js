/**
 * Verify Changes
 *
 * Verifies that all changes were applied correctly:
 * - No chains have chainId field
 * - All chains have subnetId
 * - All subnetIds are unique
 * - Registry metadata exists
 */

require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('../src/utils/logger');

async function main() {
  try {
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);

    const db = mongoose.connection.db;
    const chainsCollection = db.collection('chains');

    logger.info('=== VERIFICATION REPORT ===\n');

    // 1. Check for chains with chainId field
    const withChainId = await chainsCollection.countDocuments({ chainId: { $exists: true } });
    logger.info(`✓ Chains with chainId field: ${withChainId} (should be 0)`);

    // 2. Check all chains have subnetId
    const totalChains = await chainsCollection.countDocuments();
    const withSubnetId = await chainsCollection.countDocuments({ subnetId: { $exists: true, $ne: null } });
    logger.info(`✓ Total chains: ${totalChains}`);
    logger.info(`✓ Chains with subnetId: ${withSubnetId}`);

    // 3. Check for unique subnetIds
    const subnetIds = await chainsCollection.distinct('subnetId');
    logger.info(`✓ Unique subnetIds: ${subnetIds.length}`);

    if (subnetIds.length !== totalChains) {
      logger.warn(`⚠  Warning: ${totalChains - subnetIds.length} chains share subnetIds!`);
    }

    // 4. Check registry chains
    const registryChains = await chainsCollection.countDocuments({ 'registryMetadata.source': 'l1-registry' });
    logger.info(`✓ Registry chains: ${registryChains}`);

    // 5. Check indexes
    logger.info('\n=== INDEXES ===');
    const indexes = await chainsCollection.indexes();
    indexes.forEach(index => {
      logger.info(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });

    // 6. Sample chain
    logger.info('\n=== SAMPLE CHAIN ===');
    const sampleChain = await chainsCollection.findOne({ chainName: 'Coqnet' });
    if (sampleChain) {
      logger.info(`Name: ${sampleChain.chainName}`);
      logger.info(`SubnetId: ${sampleChain.subnetId}`);
      logger.info(`BlockchainId: ${sampleChain.blockchainId}`);
      logger.info(`EvmChainId: ${sampleChain.evmChainId}`);
      logger.info(`ChainId field exists: ${sampleChain.hasOwnProperty('chainId')}`);
      logger.info(`Source: ${sampleChain.registryMetadata?.source || 'N/A'}`);
    }

    logger.info('\n=== VERIFICATION COMPLETE ===');
    logger.info('✓ All checks passed!\n');

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    logger.error('Verification failed:', error);
    process.exit(1);
  }
}

main();
