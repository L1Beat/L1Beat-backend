/**
 * Drop chainId Index
 *
 * Drops the chainId_1 index from the chains collection
 * so we can safely remove the chainId field.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('../src/utils/logger');

async function main() {
  try {
    // Connect to database
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    logger.info('Connecting to database...');
    await mongoose.connect(dbUri);
    logger.info('Connected to database\n');

    // Get the collection
    const db = mongoose.connection.db;
    const chainsCollection = db.collection('chains');

    // List existing indexes
    logger.info('Current indexes:');
    const indexes = await chainsCollection.indexes();
    indexes.forEach(index => {
      logger.info(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });

    // Drop the chainId_1 index
    logger.info('\nDropping chainId_1 index...');
    try {
      await chainsCollection.dropIndex('chainId_1');
      logger.info('✓ chainId_1 index dropped successfully');
    } catch (error) {
      if (error.code === 27 || error.codeName === 'IndexNotFound') {
        logger.info('Index chainId_1 does not exist (already dropped)');
      } else {
        throw error;
      }
    }

    // Show remaining indexes
    logger.info('\nRemaining indexes:');
    const remainingIndexes = await chainsCollection.indexes();
    remainingIndexes.forEach(index => {
      logger.info(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });

    await mongoose.disconnect();
    logger.info('\nDisconnected from database');
    process.exit(0);
  } catch (error) {
    logger.error('Error:', error);
    process.exit(1);
  }
}

main();
