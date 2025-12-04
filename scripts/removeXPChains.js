/**
 * Remove X-Chain and P-Chain
 *
 * These are part of the Avalanche primary network, not L1s.
 * We only want to keep C-Chain and actual L1 subnets.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const logger = require('../src/utils/logger');

async function main() {
  try {
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    logger.info('Connecting to database...');
    await mongoose.connect(dbUri);
    logger.info('Connected to database\n');

    // Find X-Chain and P-Chain
    const xpChains = await Chain.find({
      chainName: { $in: ['X-Chain', 'P-Chain'] }
    });

    logger.info(`Found ${xpChains.length} chains to remove:`);
    xpChains.forEach(chain => {
      logger.info(`  - ${chain.chainName} (chainId: ${chain.chainId})`);
    });

    if (xpChains.length === 0) {
      logger.info('\nNo X-Chain or P-Chain found. Nothing to delete.');
      await mongoose.disconnect();
      process.exit(0);
    }

    // Delete them
    logger.info('\nDeleting X-Chain and P-Chain...');
    const result = await Chain.deleteMany({
      chainName: { $in: ['X-Chain', 'P-Chain'] }
    });

    logger.info(`Deleted ${result.deletedCount} chains`);

    // Verify
    const remaining = await Chain.countDocuments();
    logger.info(`\nChains remaining in database: ${remaining}`);

    await mongoose.disconnect();
    logger.info('Disconnected from database');
    process.exit(0);
  } catch (error) {
    logger.error('Error:', error);
    process.exit(1);
  }
}

main();
