/**
 * Find Duplicate Chains by SubnetId Script
 *
 * This script identifies duplicate chains based on subnetId,
 * which is unique for each L1. Chains may have slightly different
 * names (e.g., "beam" vs "Beam L1" or "coqnet" vs "Coqnet")
 * but share the same subnetId.
 *
 * Usage:
 *   node scripts/findDuplicatesBySubnetId.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const logger = require('../src/utils/logger');

async function findDuplicatesBySubnetId() {
  try {
    logger.info('Finding duplicate chains by subnetId...\n');

    // Get all chains from database
    const allChains = await Chain.find({}).lean();
    logger.info(`Total chains in database: ${allChains.length}\n`);

    // Group chains by subnetId
    const chainsBySubnetId = {};
    const chainsWithoutSubnetId = [];

    for (const chain of allChains) {
      if (chain.subnetId) {
        if (!chainsBySubnetId[chain.subnetId]) {
          chainsBySubnetId[chain.subnetId] = [];
        }
        chainsBySubnetId[chain.subnetId].push(chain);
      } else {
        chainsWithoutSubnetId.push(chain);
      }
    }

    // Find duplicates (same subnetId, multiple chains)
    const duplicateGroups = Object.entries(chainsBySubnetId)
      .filter(([subnetId, chains]) => chains.length > 1)
      .sort((a, b) => a[1][0].chainName?.localeCompare(b[1][0].chainName));

    logger.info(`Found ${duplicateGroups.length} subnetIds with duplicate chains\n`);

    if (chainsWithoutSubnetId.length > 0) {
      logger.info(`Note: ${chainsWithoutSubnetId.length} chains don't have a subnetId (likely P-Chain/X-Chain/C-Chain)\n`);
    }

    let totalDuplicates = 0;

    for (const [subnetId, chains] of duplicateGroups) {
      logger.info(`${'='.repeat(80)}`);
      logger.info(`SUBNET ID: ${subnetId}`);
      logger.info(`DUPLICATE CHAINS: ${chains.length} instances`);
      logger.info(`${'='.repeat(80)}\n`);

      const registryChains = chains.filter(c => c.registryMetadata?.source === 'l1-registry');
      const nonRegistryChains = chains.filter(c => !c.registryMetadata?.source || c.registryMetadata.source !== 'l1-registry');

      chains.forEach((chain, index) => {
        const isRegistry = chain.registryMetadata?.source === 'l1-registry';
        const action = isRegistry ? '[KEEP]' : '[DELETE]';

        logger.info(`  ${action} [${index + 1}] ${chain.chainName}`);
        logger.info(`      _id: ${chain._id}`);
        logger.info(`      chainId: ${chain.chainId}`);
        logger.info(`      evmChainId: ${chain.evmChainId || 'N/A'}`);
        logger.info(`      blockchainId: ${chain.blockchainId ? chain.blockchainId.substring(0, 30) + '...' : 'N/A'}`);
        logger.info(`      source: ${chain.registryMetadata?.source || 'No source (Glacier)'}`);
        logger.info(`      validators: ${chain.validators?.length || 0}`);
        logger.info(`      lastUpdated: ${chain.lastUpdated || 'N/A'}\n`);
      });

      logger.info(`  DECISION:`);
      if (registryChains.length === 1 && nonRegistryChains.length > 0) {
        logger.info(`    ✓ Keep 1 registry chain, delete ${nonRegistryChains.length} non-registry chain(s)`);
        totalDuplicates += nonRegistryChains.length;
      } else if (registryChains.length > 1) {
        logger.info(`    ⚠ Multiple registry chains! Keep the most recent, delete ${registryChains.length - 1} registry + ${nonRegistryChains.length} non-registry`);
        totalDuplicates += chains.length - 1;
      } else if (registryChains.length === 0) {
        logger.info(`    ⚠ No registry chains! Keep one non-registry chain (most recent), delete ${nonRegistryChains.length - 1}`);
        totalDuplicates += nonRegistryChains.length - 1;
      }
      logger.info('');
    }

    // Summary
    logger.info(`\n${'='.repeat(80)}`);
    logger.info(`SUMMARY`);
    logger.info(`${'='.repeat(80)}`);
    logger.info(`Duplicate subnet groups: ${duplicateGroups.length}`);
    logger.info(`Total chains with duplicates: ${duplicateGroups.reduce((sum, [_, chains]) => sum + chains.length, 0)}`);
    logger.info(`Chains to delete: ${totalDuplicates}`);
    logger.info(`Chains after cleanup: ${allChains.length - totalDuplicates}`);

    return { duplicateGroups, totalDuplicates };

  } catch (error) {
    logger.error('Error finding duplicates by subnetId:', error);
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

    // Run the analysis
    await findDuplicatesBySubnetId();

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

module.exports = { findDuplicatesBySubnetId };
