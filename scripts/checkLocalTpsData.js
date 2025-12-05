/**
 * Check Local TPS Data
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TPS = require('../src/models/tps');

async function main() {
  try {
    // Force local database
    const dbUri = process.env.LOCAL_MONGODB_URI || 'mongodb://localhost:27017/glacier-chains';

    console.log('Connecting to:', dbUri);
    await mongoose.connect(dbUri);
    console.log('Connected\n');

    // Check total TPS records
    const total = await TPS.countDocuments();
    console.log(`Total TPS records: ${total}\n`);

    if (total > 0) {
      // Get date range
      const oldest = await TPS.findOne().sort({ timestamp: 1 }).select('timestamp chainId value');
      const newest = await TPS.findOne().sort({ timestamp: -1 }).select('timestamp chainId value');

      console.log('Oldest record:');
      console.log(`  Date: ${new Date(oldest.timestamp * 1000).toISOString()}`);
      console.log(`  Chain: ${oldest.chainId}, TPS: ${oldest.value}\n`);

      console.log('Newest record:');
      console.log(`  Date: ${new Date(newest.timestamp * 1000).toISOString()}`);
      console.log(`  Chain: ${newest.chainId}, TPS: ${newest.value}\n`);

      // Count unique chains
      const uniqueChains = await TPS.distinct('chainId');
      console.log(`Unique chains with TPS data: ${uniqueChains.length}\n`);

      // Get records from last 7 days
      const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
      const recentCount = await TPS.countDocuments({ timestamp: { $gte: sevenDaysAgo } });
      console.log(`Records from last 7 days: ${recentCount}`);

      // Get unique chains from last 7 days
      const recentChains = await TPS.distinct('chainId', { timestamp: { $gte: sevenDaysAgo } });
      console.log(`Unique chains in last 7 days: ${recentChains.length}`);
      console.log('Chain IDs:', recentChains.slice(0, 20).join(', '), recentChains.length > 20 ? '...' : '');
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
