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
    logger.info('Starting migration to remove chainId field and index...');
    logger.info(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (field will be removed)'}\n`);

    // Get the raw collection (bypass the model to access chainId field)
    const db = mongoose.connection.db;
    const chainsCollection = db.collection('chains');

    // --- STEP 1: Drop the chainId_1 index ---
    logger.info('--- Step 1: Check for chainId_1 index ---');
    try {
      const indexExists = await chainsCollection.indexExists('chainId_1');
      if (indexExists) {
        if (dryRun) {
          logger.info('[DRY RUN] Would drop index chainId_1');
        } else {
          logger.info('Dropping index chainId_1...');
          await chainsCollection.dropIndex('chainId_1');
          logger.info('Successfully dropped index chainId_1');
        }
      } else {
        logger.info('Index chainId_1 does not exist.');
      }
    } catch (err) {
       // indexExists might throw if index doesn't exist in some versions, or other errors
       // We'll just log it, but if it's "ns not found" or similar it's fine.
       logger.warn(`Note on index check: ${err.message}`);
    }

    // --- STEP 2: Remove chainId field ---
    logger.info('\n--- Step 2: Check for chainId field ---');
    
    // Count chains with chainId field
    const chainsWithChainId = await chainsCollection.countDocuments({ chainId: { $exists: true } });
    logger.info(`Chains with chainId field: ${chainsWithChainId}`);

    let removedCount = 0;

    if (chainsWithChainId > 0) {
      // Show sample chains that will be updated
      const sampleChains = await chainsCollection.find({ chainId: { $exists: true } }).limit(5).toArray();
      logger.info('\nSample chains that will be updated:');
      sampleChains.forEach(chain => {
        logger.info(`  - ${chain.chainName}: chainId="${chain.chainId}", subnetId="${chain.subnetId}"`);
      });

      if (dryRun) {
        logger.info(`\n[DRY RUN] Would remove chainId field from ${chainsWithChainId} chains`);
        logger.info('[DRY RUN] Run without --dry-run flag to actually remove the field');
      } else {
        // Remove the chainId field from all documents
        logger.info('\nRemoving chainId field...');
        const result = await chainsCollection.updateMany(
          { chainId: { $exists: true } },
          { $unset: { chainId: "" } }
        );
        removedCount = result.modifiedCount;
        logger.info(`Successfully removed chainId field from ${removedCount} chains`);
        
        // Verify
        const remainingWithChainId = await chainsCollection.countDocuments({ chainId: { $exists: true } });
        if (remainingWithChainId === 0) {
          logger.info('✓ All chainId fields successfully removed!');
        } else {
          logger.warn(`⚠ ${remainingWithChainId} chains still have chainId field`);
        }
      }
    } else {
      logger.info('No chains have chainId field. Nothing to remove.');
    }

    return { removed: removedCount };

  } catch (error) {
    logger.error('Error during migration:', error);
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
