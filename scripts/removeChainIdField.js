/**
 * Remove chainId Field Migration
 *
 * This script removes the chainId field from all chains in the database.
 * We now use subnetId as the unique identifier instead.
 *
 * Usage:
 *   node scripts/removeChainIdField.js [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('../src/utils/logger');

async function removeChainIdField(dryRun = false) {
  try {
    logger.info('Removing chainId field from all chains...');
    logger.info(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (field will be removed)'}\n`);

    // Get the raw collection (bypass the model to access chainId field)
    const db = mongoose.connection.db;
    const chainsCollection = db.collection('chains');

    // Count chains with chainId field
    const chainsWithChainId = await chainsCollection.countDocuments({ chainId: { $exists: true } });
    logger.info(`Chains with chainId field: ${chainsWithChainId}`);

    if (chainsWithChainId === 0) {
      logger.info('\nNo chains have chainId field. Nothing to remove.');
      return { removed: 0 };
    }

    // Show sample chains that will be updated
    const sampleChains = await chainsCollection.find({ chainId: { $exists: true } }).limit(5).toArray();
    logger.info('\nSample chains that will be updated:');
    sampleChains.forEach(chain => {
      logger.info(`  - ${chain.chainName}: chainId="${chain.chainId}", subnetId="${chain.subnetId}"`);
    });

    if (dryRun) {
      logger.info(`\n[DRY RUN] Would remove chainId field from ${chainsWithChainId} chains`);
      logger.info('[DRY RUN] Run without --dry-run flag to actually remove the field');
      return { removed: 0 };
    }

    // Remove the chainId field from all documents
    logger.info('\nRemoving chainId field...');
    const result = await chainsCollection.updateMany(
      { chainId: { $exists: true } },
      { $unset: { chainId: "" } }
    );

    logger.info(`Successfully removed chainId field from ${result.modifiedCount} chains`);

    // Verify
    const remainingWithChainId = await chainsCollection.countDocuments({ chainId: { $exists: true } });
    logger.info(`\nChains still with chainId field: ${remainingWithChainId}`);

    if (remainingWithChainId === 0) {
      logger.info('✓ All chainId fields successfully removed!');
    } else {
      logger.warn(`⚠ ${remainingWithChainId} chains still have chainId field`);
    }

    return { removed: result.modifiedCount };

  } catch (error) {
    logger.error('Error removing chainId field:', error);
    throw error;
  }
}

async function main() {
  try {
    // Parse command line arguments
    const dryRun = process.argv.includes('--dry-run');

    // Connect to database
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    logger.info('Connecting to database...');
    await mongoose.connect(dbUri);
    logger.info('Connected to database\n');

    // Run the migration
    const result = await removeChainIdField(dryRun);

    logger.info('\n=== Summary ===');
    logger.info(`Fields removed: ${result.removed}`);
    if (dryRun) {
      logger.info('Mode: DRY RUN (no changes made)');
    }

    // Disconnect
    await mongoose.disconnect();
    logger.info('\nDisconnected from database');

    process.exit(0);
  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = { removeChainIdField };
