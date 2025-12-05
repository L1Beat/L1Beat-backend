/**
 * Analyze Chain TPS Data
 *
 * Shows which chains have TPS data and how much
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const TPS = require('../src/models/tps');
const logger = require('../src/utils/logger');

async function main() {
  try {
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);
    console.log('Connected to database\n');

    // Get latest TPS data for each chain
    const oneDayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60);

    const tpsData = await TPS.aggregate([
      {
        $match: {
          timestamp: { $gte: oneDayAgo }
        }
      },
      {
        $sort: { timestamp: -1 }
      },
      {
        $group: {
          _id: '$chainId',
          latestTps: { $first: '$value' },
          latestTimestamp: { $first: '$timestamp' },
          recordCount: { $sum: 1 }
        }
      },
      {
        $sort: { latestTps: -1 }
      }
    ]);

    console.log(`Found ${tpsData.length} chains with TPS data in last 24h\n`);

    // Get chain details for each
    const chains = await Chain.find({
      evmChainId: { $exists: true, $ne: null }
    }).select('evmChainId chainName validators').lean();

    const chainMap = {};
    chains.forEach(chain => {
      chainMap[String(chain.evmChainId)] = {
        name: chain.chainName,
        hasValidators: chain.validators && chain.validators.length > 0,
        validatorCount: chain.validators ? chain.validators.length : 0
      };
    });

    // Combine the data
    console.log('Chain TPS Breakdown:\n');
    console.log('Rank | Chain ID | Chain Name | TPS | Validators | Records');
    console.log('-----|----------|------------|-----|------------|--------');

    let totalTps = 0;
    let chainsWithValidators = 0;
    let chainsWithoutValidators = 0;

    tpsData.forEach((data, index) => {
      const chainInfo = chainMap[data._id] || { name: 'Unknown', hasValidators: false, validatorCount: 0 };
      const hasValidators = chainInfo.hasValidators ? '✓' : '✗';

      console.log(
        `${String(index + 1).padStart(4)} | ` +
        `${data._id.padEnd(8)} | ` +
        `${(chainInfo.name || 'Unknown').padEnd(30).slice(0, 30)} | ` +
        `${String(data.latestTps).padStart(3)} | ` +
        `${hasValidators} ${String(chainInfo.validatorCount).padStart(4)} | ` +
        `${String(data.recordCount).padStart(6)}`
      );

      totalTps += data.latestTps;
      if (chainInfo.hasValidators) {
        chainsWithValidators++;
      } else {
        chainsWithoutValidators++;
      }
    });

    console.log('\n=== SUMMARY ===');
    console.log(`Total chains with TPS data: ${tpsData.length}`);
    console.log(`Chains with validators: ${chainsWithValidators}`);
    console.log(`Chains WITHOUT validators: ${chainsWithoutValidators}`);
    console.log(`Total TPS: ${totalTps.toFixed(2)}`);

    console.log('\n=== Top 10 Chains by TPS ===');
    tpsData.slice(0, 10).forEach((data, index) => {
      const chainInfo = chainMap[data._id] || { name: 'Unknown' };
      console.log(`${index + 1}. ${chainInfo.name} (${data._id}): ${data.latestTps} TPS`);
    });

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
