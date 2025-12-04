/**
 * Diagnose Duplicate Chains Script
 *
 * This script analyzes all chains in the database to identify duplicates
 * and show detailed information about why they might not be matched.
 *
 * Usage:
 *   node scripts/diagnoseDuplicates.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const logger = require('../src/utils/logger');

async function diagnoseDuplicates() {
  try {
    logger.info('Analyzing chains for duplicates...\n');

    // Get all chains from database
    const allChains = await Chain.find({}).lean();
    logger.info(`Total chains in database: ${allChains.length}\n`);

    // Group chains by name (case-insensitive) to find potential duplicates
    const chainsByName = {};
    for (const chain of allChains) {
      const normalizedName = chain.chainName?.toLowerCase().trim() || 'unknown';
      if (!chainsByName[normalizedName]) {
        chainsByName[normalizedName] = [];
      }
      chainsByName[normalizedName].push(chain);
    }

    // Find duplicates
    const duplicateGroups = Object.entries(chainsByName)
      .filter(([name, chains]) => chains.length > 1)
      .sort((a, b) => a[0].localeCompare(b[0]));

    logger.info(`Found ${duplicateGroups.length} chain names with duplicates:\n`);

    for (const [name, chains] of duplicateGroups) {
      logger.info(`\n${'='.repeat(80)}`);
      logger.info(`CHAIN NAME: ${name.toUpperCase()} (${chains.length} instances)`);
      logger.info(`${'='.repeat(80)}\n`);

      chains.forEach((chain, index) => {
        logger.info(`  [${index + 1}] ${chain.chainName}`);
        logger.info(`      _id: ${chain._id}`);
        logger.info(`      chainId: ${chain.chainId}`);
        logger.info(`      evmChainId: ${chain.evmChainId || 'N/A'}`);
        logger.info(`      blockchainId: ${chain.blockchainId || 'N/A'}`);
        logger.info(`      platformChainId: ${chain.platformChainId || 'N/A'}`);
        logger.info(`      subnetId: ${chain.subnetId || 'N/A'}`);
        logger.info(`      source: ${chain.registryMetadata?.source || 'No source (likely Glacier)'}`);
        logger.info(`      validators: ${chain.validators?.length || 0}`);
        logger.info(`      lastUpdated: ${chain.lastUpdated || 'N/A'}\n`);
      });

      // Analysis
      logger.info(`  ANALYSIS:`);
      const registryChains = chains.filter(c => c.registryMetadata?.source === 'l1-registry');
      const glacierChains = chains.filter(c => !c.registryMetadata?.source);

      logger.info(`    - Registry chains: ${registryChains.length}`);
      logger.info(`    - Glacier/Unknown chains: ${glacierChains.length}`);

      if (registryChains.length > 0 && glacierChains.length > 0) {
        logger.info(`    - Should be merged: YES`);
        const regChain = registryChains[0];
        const glacierChain = glacierChains[0];

        logger.info(`\n    MATCHING CRITERIA:`);
        logger.info(`      Registry evmChainId (${regChain.evmChainId}) == Glacier chainId (${glacierChain.chainId}): ${String(regChain.evmChainId) === String(glacierChain.chainId)}`);
        logger.info(`      Registry blockchainId (${regChain.blockchainId?.substring(0, 10)}...) == Glacier platformChainId (${glacierChain.platformChainId?.substring(0, 10)}...): ${regChain.blockchainId === glacierChain.platformChainId}`);
      } else if (registryChains.length > 1) {
        logger.info(`    - Multiple registry chains with same name! (Unexpected)`);
      } else if (glacierChains.length > 1) {
        logger.info(`    - Multiple Glacier chains with same name! (Unexpected)`);
      }
    }

    // Summary
    logger.info(`\n\n${'='.repeat(80)}`);
    logger.info(`SUMMARY`);
    logger.info(`${'='.repeat(80)}`);
    logger.info(`Total duplicate groups: ${duplicateGroups.length}`);
    logger.info(`Total duplicate chains: ${duplicateGroups.reduce((sum, [_, chains]) => sum + chains.length, 0)}`);
    logger.info(`Chains to keep: ${duplicateGroups.length} (one per group)`);
    logger.info(`Chains to delete: ${duplicateGroups.reduce((sum, [_, chains]) => sum + chains.length - 1, 0)}`);

    // Check for chains with similar names (like "beam" vs "Beam L1")
    logger.info(`\n\n${'='.repeat(80)}`);
    logger.info(`SIMILAR NAMES (potential duplicates with different names)`);
    logger.info(`${'='.repeat(80)}\n`);

    const seenNames = new Set();
    for (const chain of allChains) {
      const baseName = chain.chainName?.toLowerCase().replace(/\s*(l1|chain|network|subnet)\s*/gi, '').trim();
      if (baseName && seenNames.has(baseName)) {
        // Find all chains with similar base name
        const similar = allChains.filter(c => {
          const otherBase = c.chainName?.toLowerCase().replace(/\s*(l1|chain|network|subnet)\s*/gi, '').trim();
          return otherBase === baseName;
        });

        if (similar.length > 1) {
          logger.info(`\nSimilar chains for "${baseName}":`);
          similar.forEach(s => {
            logger.info(`  - ${s.chainName} (chainId: ${s.chainId}, source: ${s.registryMetadata?.source || 'Glacier'})`);
          });
        }
      }
      if (baseName) seenNames.add(baseName);
    }

  } catch (error) {
    logger.error('Error diagnosing duplicates:', error);
    throw error;
  }
}

async function main() {
  try {
    // Connect to database
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    logger.info('Connecting to database...');
    await mongoose.connect(dbUri);
    logger.info('Connected to database\n');

    // Run the diagnosis
    await diagnoseDuplicates();

    // Disconnect
    await mongoose.disconnect();
    logger.info('\nDisconnected from database');

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

module.exports = { diagnoseDuplicates };
