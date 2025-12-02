const mongoose = require('mongoose');
const ActiveAddresses = require('../src/models/activeAddresses');
const TxCount = require('../src/models/txCount');
const Chain = require('../src/models/chain');
const getDbUri = require('./helpers/getDbUri');
require('dotenv').config();

async function diagnoseRecentMetrics() {
  try {
    const dbUri = getDbUri();
    await mongoose.connect(dbUri);
    console.log('✅ Connected to database\n');

    const currentTime = Math.floor(Date.now() / 1000);
    const threeDaysAgo = currentTime - (3 * 24 * 60 * 60);
    const sevenDaysAgo = currentTime - (7 * 24 * 60 * 60);

    console.log('=== TIME RANGES ===');
    console.log(`Current time: ${new Date(currentTime * 1000).toISOString()}`);
    console.log(`3 days ago: ${new Date(threeDaysAgo * 1000).toISOString()}`);
    console.log(`7 days ago: ${new Date(sevenDaysAgo * 1000).toISOString()}\n`);

    // Get all active chains
    const chains = await Chain.find({ isActive: true }).lean();
    console.log(`📊 Found ${chains.length} active chains\n`);

    // === ACTIVE ADDRESSES ANALYSIS ===
    console.log('=== ACTIVE ADDRESSES ANALYSIS ===\n');

    // Check last 3 days
    const recentActiveAddresses = await ActiveAddresses.find({
      timestamp: { $gte: threeDaysAgo, $lte: currentTime }
    }).lean();

    console.log(`Recent (last 3 days): ${recentActiveAddresses.length} records`);

    // Group by timestamp and count chains
    const activeAddressesGrouped = {};
    recentActiveAddresses.forEach(record => {
      if (!activeAddressesGrouped[record.timestamp]) {
        activeAddressesGrouped[record.timestamp] = {
          chains: new Set(),
          totalValue: 0
        };
      }
      activeAddressesGrouped[record.timestamp].chains.add(record.chainId);
      activeAddressesGrouped[record.timestamp].totalValue += record.value;
    });

    console.log('\nActive Addresses by Day (last 3 days):');
    Object.entries(activeAddressesGrouped)
      .sort((a, b) => b[0] - a[0])
      .forEach(([timestamp, data]) => {
        const date = new Date(Number(timestamp) * 1000).toISOString().split('T')[0];
        console.log(`  ${date}: ${data.chains.size} chains, Total: ${data.totalValue.toLocaleString()}`);
      });

    // Check 7 days for comparison
    const weekActiveAddresses = await ActiveAddresses.find({
      timestamp: { $gte: sevenDaysAgo, $lt: threeDaysAgo }
    }).lean();

    console.log(`\nComparison (days 4-7): ${weekActiveAddresses.length} records`);

    const weekGrouped = {};
    weekActiveAddresses.forEach(record => {
      if (!weekGrouped[record.timestamp]) {
        weekGrouped[record.timestamp] = {
          chains: new Set(),
          totalValue: 0
        };
      }
      weekGrouped[record.timestamp].chains.add(record.chainId);
      weekGrouped[record.timestamp].totalValue += record.value;
    });

    console.log('\nActive Addresses by Day (days 4-7):');
    Object.entries(weekGrouped)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 4)
      .forEach(([timestamp, data]) => {
        const date = new Date(Number(timestamp) * 1000).toISOString().split('T')[0];
        console.log(`  ${date}: ${data.chains.size} chains, Total: ${data.totalValue.toLocaleString()}`);
      });

    // === TX COUNT ANALYSIS ===
    console.log('\n\n=== TX COUNT ANALYSIS ===\n');

    // Check last 3 days
    const recentTxCount = await TxCount.find({
      timestamp: { $gte: threeDaysAgo, $lte: currentTime }
    }).lean();

    console.log(`Recent (last 3 days): ${recentTxCount.length} records`);

    // Group by timestamp
    const txCountGrouped = {};
    recentTxCount.forEach(record => {
      if (!txCountGrouped[record.timestamp]) {
        txCountGrouped[record.timestamp] = {
          chains: new Set(),
          totalValue: 0
        };
      }
      txCountGrouped[record.timestamp].chains.add(record.chainId);
      txCountGrouped[record.timestamp].totalValue += record.value;
    });

    console.log('\nTx Count by Day (last 3 days):');
    Object.entries(txCountGrouped)
      .sort((a, b) => b[0] - a[0])
      .forEach(([timestamp, data]) => {
        const date = new Date(Number(timestamp) * 1000).toISOString().split('T')[0];
        console.log(`  ${date}: ${data.chains.size} chains, Total: ${data.totalValue.toLocaleString()}`);
      });

    // Check 7 days for comparison
    const weekTxCount = await TxCount.find({
      timestamp: { $gte: sevenDaysAgo, $lt: threeDaysAgo }
    }).lean();

    console.log(`\nComparison (days 4-7): ${weekTxCount.length} records`);

    const weekTxGrouped = {};
    weekTxCount.forEach(record => {
      if (!weekTxGrouped[record.timestamp]) {
        weekTxGrouped[record.timestamp] = {
          chains: new Set(),
          totalValue: 0
        };
      }
      weekTxGrouped[record.timestamp].chains.add(record.chainId);
      weekTxGrouped[record.timestamp].totalValue += record.value;
    });

    console.log('\nTx Count by Day (days 4-7):');
    Object.entries(weekTxGrouped)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 4)
      .forEach(([timestamp, data]) => {
        const date = new Date(Number(timestamp) * 1000).toISOString().split('T')[0];
        console.log(`  ${date}: ${data.chains.size} chains, Total: ${data.totalValue.toLocaleString()}`);
      });

    // === MISSING CHAINS ANALYSIS ===
    console.log('\n\n=== MISSING CHAINS ANALYSIS ===\n');

    // Find chains with no recent data
    const chainsWithRecentActiveAddresses = new Set(recentActiveAddresses.map(r => r.chainId));
    const chainsWithRecentTxCount = new Set(recentTxCount.map(r => r.chainId));

    const validChainIds = chains
      .map(c => String(c.evmChainId || c.chainId))
      .filter(id => id && /^\d+$/.test(id));

    const missingActiveAddresses = validChainIds.filter(id => !chainsWithRecentActiveAddresses.has(id));
    const missingTxCount = validChainIds.filter(id => !chainsWithRecentTxCount.has(id));

    console.log(`Chains missing Active Addresses data (last 3 days): ${missingActiveAddresses.length}`);
    if (missingActiveAddresses.length > 0 && missingActiveAddresses.length <= 10) {
      console.log('  Missing:', missingActiveAddresses.join(', '));
    }

    console.log(`\nChains missing Tx Count data (last 3 days): ${missingTxCount.length}`);
    if (missingTxCount.length > 0 && missingTxCount.length <= 10) {
      console.log('  Missing:', missingTxCount.join(', '));
    }

    // === RECOMMENDATION ===
    console.log('\n\n=== DIAGNOSIS ===\n');

    const recentAvgChains = Object.values(activeAddressesGrouped).length > 0
      ? Object.values(activeAddressesGrouped).reduce((sum, d) => sum + d.chains.size, 0) / Object.values(activeAddressesGrouped).length
      : 0;

    const weekAvgChains = Object.values(weekGrouped).length > 0
      ? Object.values(weekGrouped).reduce((sum, d) => sum + d.chains.size, 0) / Object.values(weekGrouped).length
      : 0;

    console.log(`Average chains reporting per day:`);
    console.log(`  Last 3 days: ${recentAvgChains.toFixed(1)} chains`);
    console.log(`  Days 4-7: ${weekAvgChains.toFixed(1)} chains`);

    if (recentAvgChains < weekAvgChains * 0.5) {
      console.log('\n⚠️  ISSUE FOUND: Recent days have significantly fewer chains reporting data');
      console.log('   This explains the low network-wide totals.');
      console.log('\nPossible causes:');
      console.log('  1. Cron job failing for some chains');
      console.log('  2. Glacier API not returning recent data for some chains');
      console.log('  3. Data validation filtering out valid recent data');
    } else if (Object.keys(activeAddressesGrouped).length < 3) {
      console.log('\n⚠️  ISSUE FOUND: Missing data for some days in the last 3 days');
      console.log('   Expected 3 days of data, but found:', Object.keys(activeAddressesGrouped).length);
    } else {
      console.log('\n✅ Data coverage looks normal. Issue may be with data values, not coverage.');
    }

    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

diagnoseRecentMetrics();
