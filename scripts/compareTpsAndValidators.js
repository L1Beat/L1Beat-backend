/**
 * Compare TPS Data vs Validators
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const TPS = require('../src/models/tps');

async function main() {
  try {
    const dbUri = process.env.LOCAL_MONGODB_URI || 'mongodb://localhost:27017/glacier-chains';

    console.log('Connecting to:', dbUri);
    await mongoose.connect(dbUri);
    console.log('Connected\n');

    // Get latest TPS for each chain (from last 7 days)
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);

    const tpsData = await TPS.aggregate([
      {
        $match: { timestamp: { $gte: sevenDaysAgo } }
      },
      {
        $sort: { timestamp: -1 }
      },
      {
        $group: {
          _id: '$chainId',
          latestTps: { $first: '$value' },
          latestTimestamp: { $first: '$timestamp' }
        }
      },
      {
        $sort: { latestTps: -1 }
      }
    ]);

    // Get all chains
    const chains = await Chain.find().select('evmChainId chainName validators').lean();

    const chainMap = {};
    chains.forEach(chain => {
      if (chain.evmChainId) {
        chainMap[String(chain.evmChainId)] = {
          name: chain.chainName || 'Unknown',
          validatorCount: chain.validators ? chain.validators.length : 0
        };
      }
    });

    console.log(`Total chains in database: ${chains.length}`);
    console.log(`Chains with TPS data: ${tpsData.length}\n`);

    let chainsWithValidators = 0;
    let chainsWithoutValidators = 0;
    let totalTps = 0;

    console.log('Top 20 Chains by TPS:\n');
    console.log('Rank | Chain Name                    | EVM ID | TPS  | Validators');
    console.log('-----|-------------------------------|--------|------|------------');

    tpsData.slice(0, 20).forEach((data, index) => {
      const chainInfo = chainMap[data._id] || { name: 'Unknown Chain', validatorCount: 0 };
      const hasValidators = chainInfo.validatorCount > 0;

      console.log(
        `${String(index + 1).padStart(4)} | ` +
        `${chainInfo.name.padEnd(29).slice(0, 29)} | ` +
        `${data._id.padEnd(6)} | ` +
        `${String(data.latestTps).padStart(4)} | ` +
        `${hasValidators ? '✓' : '✗'} ${String(chainInfo.validatorCount).padStart(4)}`
      );

      totalTps += data.latestTps;
      if (hasValidators) {
        chainsWithValidators++;
      } else {
        chainsWithoutValidators++;
      }
    });

    // Count for all chains
    const allChainsWithValidators = tpsData.filter(data => {
      const chainInfo = chainMap[data._id];
      return chainInfo && chainInfo.validatorCount > 0;
    }).length;

    const allChainsWithoutValidators = tpsData.length - allChainsWithValidators;

    console.log('\n=== SUMMARY (All Chains with TPS) ===');
    console.log(`Total chains with TPS data: ${tpsData.length}`);
    console.log(`Chains WITH validators: ${allChainsWithValidators}`);
    console.log(`Chains WITHOUT validators: ${allChainsWithoutValidators}`);

    // Show chains without validators that have TPS
    console.log('\n=== Chains with TPS but NO Validators (sample) ===');
    const chainsWithoutValidatorsList = tpsData.filter(data => {
      const chainInfo = chainMap[data._id];
      return !chainInfo || chainInfo.validatorCount === 0;
    }).slice(0, 10);

    chainsWithoutValidatorsList.forEach(data => {
      const chainInfo = chainMap[data._id] || { name: 'Unknown Chain' };
      console.log(`- ${chainInfo.name} (${data._id}): ${data.latestTps} TPS`);
    });

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
