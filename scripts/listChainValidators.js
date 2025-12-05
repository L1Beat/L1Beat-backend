/**
 * List Chains with Validator Counts
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');

async function main() {
  try {
    const dbUri = process.env.LOCAL_MONGODB_URI || 'mongodb://localhost:27017/glacier-chains';

    console.log('Connecting to database...');
    await mongoose.connect(dbUri);
    console.log('Connected\n');

    // Get all chains with validator data
    const chains = await Chain.find()
      .select('chainName evmChainId subnetId validators')
      .lean();

    // Sort by validator count (descending)
    const sortedChains = chains
      .map(chain => ({
        name: chain.chainName || 'Unknown',
        evmChainId: chain.evmChainId || 'N/A',
        subnetId: chain.subnetId ? chain.subnetId.substring(0, 20) + '...' : 'N/A',
        validatorCount: chain.validators ? chain.validators.length : 0
      }))
      .sort((a, b) => b.validatorCount - a.validatorCount);

    const chainsWithValidators = sortedChains.filter(c => c.validatorCount > 0);
    const chainsWithoutValidators = sortedChains.filter(c => c.validatorCount === 0);

    console.log('=== CHAINS WITH VALIDATORS ===\n');
    console.log('Rank | Chain Name                     | EVM Chain ID | Validators');
    console.log('-----|--------------------------------|--------------|------------');

    chainsWithValidators.forEach((chain, index) => {
      console.log(
        `${String(index + 1).padStart(4)} | ` +
        `${chain.name.padEnd(30).slice(0, 30)} | ` +
        `${String(chain.evmChainId).padEnd(12)} | ` +
        `${String(chain.validatorCount).padStart(10)}`
      );
    });

    console.log('\n=== SUMMARY ===');
    console.log(`Total chains: ${chains.length}`);
    console.log(`Chains with validators: ${chainsWithValidators.length}`);
    console.log(`Chains without validators: ${chainsWithoutValidators.length}`);
    console.log(`Total validators: ${sortedChains.reduce((sum, c) => sum + c.validatorCount, 0)}`);

    // Show top 10 by validator count
    console.log('\n=== TOP 10 CHAINS BY VALIDATOR COUNT ===');
    chainsWithValidators.slice(0, 10).forEach((chain, index) => {
      console.log(`${index + 1}. ${chain.name}: ${chain.validatorCount} validators`);
    });

    await mongoose.disconnect();
    console.log('\nDone!');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
