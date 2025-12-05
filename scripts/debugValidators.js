/**
 * Debug Validator Fetching
 *
 * Diagnoses why validators are missing for many chains.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const chainService = require('../src/services/chainService');
const logger = require('../src/utils/logger');

async function main() {
  try {
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    // Fail fast if no URI is available
    if (!dbUri) {
      logger.error('No MongoDB URI found. Please check your .env file or environment variables.');
      logger.error('Variables checked: PROD_MONGODB_URI, LOCAL_MONGODB_URI, DEV_MONGODB_URI');
      process.exit(1);
    }

    logger.info('=== VALIDATOR FETCH DIAGNOSTICS ===\n');
    logger.info(`Using Database: ${dbUri}`);
    
    logger.info('Connecting to database...');
    await mongoose.connect(dbUri);
    logger.info('Connected.\n');

    // 1. Get statistics on chains with validators
    const totalChains = await Chain.countDocuments();
    const chainsWithValidators = await Chain.countDocuments({ 'validators.0': { $exists: true } });
    
    logger.info(`Total Chains: ${totalChains}`);
    logger.info(`Chains with Validators: ${chainsWithValidators}`);
    logger.info(`Missing Validators: ${totalChains - chainsWithValidators}\n`);

    // 2. Test fetching for a few chains that SHOULD have validators but don't
    const sampleChains = await Chain.find({ 
        'validators.0': { $exists: false },
        subnetId: { $exists: true, $ne: null }
    }).limit(5);

    if (sampleChains.length === 0) {
        logger.info('No chains found with missing validators to test.');
    } else {
        logger.info('Testing fetch for 5 sample chains without validators:');
        
        for (const chain of sampleChains) {
            logger.info(`\n--- Testing Chain: ${chain.chainName} ---`);
            logger.info(`SubnetId: ${chain.subnetId}`);
            
            try {
                logger.info('Attempting to fetch validators...');
                const validators = await chainService.fetchValidators(chain.subnetId, chain.evmChainId || chain.blockchainId);
                logger.info(`Fetch Result: Found ${validators.length} validators`);
                
                if (validators.length > 0) {
                    logger.info('Sample validator:', validators[0].nodeId);
                } else {
                    logger.warn(' Still 0 validators found via API.');
                }
            } catch (err) {
                logger.error(`Fetch failed: ${err.message}`);
            }
        }
    }
    
    // 3. Test specifically for a known chain that should have validators (like DFK or Beam)
    const knownChain = await Chain.findOne({ chainName: /DFK|Beam|Dexalot/i });
    if (knownChain) {
         logger.info(`\n--- Control Test: ${knownChain.chainName} ---`);
         logger.info(`SubnetId: ${knownChain.subnetId}`);
         logger.info(`Current DB Validator Count: ${knownChain.validators.length}`);
         
         try {
            const validators = await chainService.fetchValidators(knownChain.subnetId, knownChain.evmChainId);
            logger.info(`API Fetch Count: ${validators.length}`);
         } catch (err) {
             logger.error(`Control test fetch failed: ${err.message}`);
         }
    }

    await mongoose.disconnect();
    logger.info('\n=== DIAGNOSTICS COMPLETE ===');
    process.exit(0);
  } catch (error) {
    logger.error('Error:', error);
    process.exit(1);
  }
}

main();

