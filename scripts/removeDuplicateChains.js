/**
 * Remove Duplicate Chains Script
 *
 * This script identifies and removes duplicate chains from the database.
 * It keeps chains from l1-registry and removes Glacier duplicates.
 *
 * Duplicates are identified when:
 * - A non-registry chain exists with chainId that matches a registry chain's evmChainId
 * - A non-registry chain exists with platformChainId/blockchainId that matches a registry chain's blockchainId
 *
 * Usage:
 *   node scripts/removeDuplicateChains.js [--dry-run]
 *
 * Options:
 *   --dry-run   Show what would be deleted without actually deleting
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const logger = require('../src/utils/logger');

async function findAndRemoveDuplicates(dryRun = false) {
  try {
    logger.info('Starting duplicate chain detection...');
    logger.info(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (duplicates will be deleted)'}`);

    // Get all chains from database
    const allChains = await Chain.find({});
    logger.info(`Total chains in database: ${allChains.length}`);

    // Separate registry chains from non-registry chains
    const registryChains = allChains.filter(c => c.registryMetadata?.source === 'l1-registry');
    const nonRegistryChains = allChains.filter(c => !c.registryMetadata?.source || c.registryMetadata.source !== 'l1-registry');

    logger.info(`Registry chains: ${registryChains.length}`);
    logger.info(`Non-registry chains: ${nonRegistryChains.length}`);

    const duplicatesToRemove = [];
    const duplicateDetails = [];

    // Find duplicates
    for (const nonRegChain of nonRegistryChains) {
      // Check if this non-registry chain has a matching registry chain
      const matchingRegistryChain = registryChains.find(regChain => {
        // Match if:
        // 1. Registry's evmChainId matches non-registry's chainId (numeric)
        const evmChainIdMatch = regChain.evmChainId && String(regChain.evmChainId) === String(nonRegChain.chainId);

        // 2. Registry's blockchainId matches non-registry's platformChainId or blockchainId
        const blockchainIdMatch = regChain.blockchainId && (
          regChain.blockchainId === nonRegChain.platformChainId ||
          regChain.blockchainId === nonRegChain.blockchainId
        );

        return evmChainIdMatch || blockchainIdMatch;
      });

      if (matchingRegistryChain) {
        duplicatesToRemove.push(nonRegChain._id);
        duplicateDetails.push({
          toDelete: {
            _id: nonRegChain._id,
            chainId: nonRegChain.chainId,
            chainName: nonRegChain.chainName,
            blockchainId: nonRegChain.blockchainId,
            platformChainId: nonRegChain.platformChainId,
            source: 'Glacier/Non-Registry'
          },
          toKeep: {
            _id: matchingRegistryChain._id,
            chainId: matchingRegistryChain.chainId,
            chainName: matchingRegistryChain.chainName,
            blockchainId: matchingRegistryChain.blockchainId,
            evmChainId: matchingRegistryChain.evmChainId,
            source: matchingRegistryChain.registryMetadata.source
          }
        });
      }
    }

    logger.info(`Found ${duplicatesToRemove.length} duplicate chains to remove`);

    if (duplicateDetails.length > 0) {
      logger.info('\nDuplicate chains details:');
      duplicateDetails.forEach((dup, index) => {
        logger.info(`\n${index + 1}. Duplicate pair:`);
        logger.info(`   TO DELETE (${dup.toDelete.source}):`, {
          chainId: dup.toDelete.chainId,
          chainName: dup.toDelete.chainName,
          blockchainId: dup.toDelete.blockchainId
        });
        logger.info(`   TO KEEP (${dup.toKeep.source}):`, {
          chainId: dup.toKeep.chainId,
          chainName: dup.toKeep.chainName,
          blockchainId: dup.toKeep.blockchainId,
          evmChainId: dup.toKeep.evmChainId
        });
      });
    }

    if (duplicatesToRemove.length === 0) {
      logger.info('\nNo duplicates found!');
      return { deleted: 0, details: [] };
    }

    if (dryRun) {
      logger.info(`\n[DRY RUN] Would delete ${duplicatesToRemove.length} duplicate chains`);
      logger.info('[DRY RUN] Run without --dry-run flag to actually delete these chains');
      return { deleted: 0, details: duplicateDetails };
    }

    // Actually delete the duplicates
    logger.info(`\nDeleting ${duplicatesToRemove.length} duplicate chains...`);
    const deleteResult = await Chain.deleteMany({ _id: { $in: duplicatesToRemove } });

    logger.info(`Successfully deleted ${deleteResult.deletedCount} duplicate chains`);

    // Verify
    const remainingChains = await Chain.find({});
    logger.info(`\nChains remaining in database: ${remainingChains.length}`);
    logger.info(`Registry chains: ${remainingChains.filter(c => c.registryMetadata?.source === 'l1-registry').length}`);

    return { deleted: deleteResult.deletedCount, details: duplicateDetails };

  } catch (error) {
    logger.error('Error finding/removing duplicates:', error);
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
    logger.info('Connected to database');

    // Run the duplicate removal
    const result = await findAndRemoveDuplicates(dryRun);

    logger.info('\n=== Summary ===');
    logger.info(`Duplicates identified: ${result.details.length}`);
    logger.info(`Duplicates deleted: ${result.deleted}`);
    if (dryRun) {
      logger.info('Mode: DRY RUN (no changes made)');
    }

    // Disconnect
    await mongoose.disconnect();
    logger.info('Disconnected from database');

    process.exit(0);
  } catch (error) {
    logger.error('Script failed:', error);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = { findAndRemoveDuplicates };
