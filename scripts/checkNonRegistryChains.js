require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const logger = require('../src/utils/logger');

async function main() {
  const dbUri = process.env.NODE_ENV === 'production'
    ? process.env.PROD_MONGODB_URI
    : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

  await mongoose.connect(dbUri);

  // Find chains without l1-registry source
  const nonRegistryChains = await Chain.find({
    $or: [
      { 'registryMetadata.source': { $exists: false } },
      { 'registryMetadata.source': { $ne: 'l1-registry' } }
    ]
  }).select('chainName chainId subnetId registryMetadata').lean();

  logger.info(`\nNon-registry chains: ${nonRegistryChains.length}\n`);

  if (nonRegistryChains.length > 0) {
    nonRegistryChains.forEach((chain, i) => {
      logger.info(`${i + 1}. ${chain.chainName}`);
      logger.info(`   chainId: ${chain.chainId}`);
      logger.info(`   subnetId: ${chain.subnetId || 'N/A'}`);
      logger.info(`   source: ${chain.registryMetadata?.source || 'No source'}\n`);
    });
  } else {
    logger.info('All chains are from l1-registry! ✓\n');
  }

  // Also check total chains
  const totalChains = await Chain.countDocuments();
  const registryChains = await Chain.countDocuments({ 'registryMetadata.source': 'l1-registry' });

  logger.info(`Total chains: ${totalChains}`);
  logger.info(`Registry chains: ${registryChains}`);
  logger.info(`Non-registry chains: ${totalChains - registryChains}\n`);

  await mongoose.disconnect();
}

main().catch(console.error);
