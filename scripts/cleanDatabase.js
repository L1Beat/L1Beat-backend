/**
 * Clean Database
 *
 * Removes all chains from the database for a fresh sync
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
    logger.info('Connected\n');

    // Count existing chains
    const count = await Chain.countDocuments();
    logger.info(`Found ${count} chains in database`);

    if (count === 0) {
      logger.info('Database is already empty');
      await mongoose.disconnect();
      process.exit(0);
    }

    // Delete all chains
    logger.info('Deleting all chains...');
    const result = await Chain.deleteMany({});
    logger.info(`✅ Deleted ${result.deletedCount} chains`);

    // Verify
    const remaining = await Chain.countDocuments();
    logger.info(`Remaining chains: ${remaining}`);

    await mongoose.disconnect();
    logger.info('Disconnected from database');
    process.exit(0);
  } catch (error) {
    logger.error('Error:', error);
    process.exit(1);
  }
}

main();
