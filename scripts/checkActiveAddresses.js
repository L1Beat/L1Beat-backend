const mongoose = require('mongoose');
const ActiveAddresses = require('../src/models/activeAddresses');
const Chain = require('../src/models/chain');
require('dotenv').config();

async function checkActiveAddressesData() {
  try {
    // Connect to database
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);
    console.log('Connected to database\n');

    // Get all chains
    const chains = await Chain.find({}).select('chainId evmChainId name').lean();
    console.log(`Total chains: ${chains.length}\n`);

    // Get the oldest and newest records
    const oldestRecord = await ActiveAddresses.findOne().sort({ timestamp: 1 }).lean();
    const newestRecord = await ActiveAddresses.findOne().sort({ timestamp: -1 }).lean();

    if (!oldestRecord || !newestRecord) {
      console.log('No active addresses data found in database');
      process.exit(0);
    }

    const oldestDate = new Date(oldestRecord.timestamp * 1000);
    const newestDate = new Date(newestRecord.timestamp * 1000);
    const daysDiff = Math.floor((newestDate - oldestDate) / (24 * 60 * 60 * 1000));

    console.log('=== Active Addresses Data Summary ===');
    console.log('Oldest record:', oldestDate.toISOString());
    console.log('Newest record:', newestDate.toISOString());
    console.log('Days of data:', daysDiff);
    console.log('Total records:', await ActiveAddresses.countDocuments());

    // Check data per chain
    console.log('\n=== Data Per Chain ===');
    for (const chain of chains) {
      const chainId = String(chain.evmChainId || chain.chainId);

      if (!chainId || !/^\d+$/.test(chainId)) continue;

      const count = await ActiveAddresses.countDocuments({ chainId });
      const latest = await ActiveAddresses.findOne({ chainId }).sort({ timestamp: -1 }).lean();

      if (count > 0) {
        console.log(`${chain.name} (${chainId}): ${count} records, latest: ${new Date(latest.timestamp * 1000).toISOString()}`);
      }
    }

    // Recent records
    const recentRecords = await ActiveAddresses.find()
      .sort({ timestamp: -1 })
      .limit(10)
      .lean();

    console.log('\n=== Recent Records ===');
    recentRecords.forEach(record => {
      const date = new Date(record.timestamp * 1000);
      console.log(`${date.toISOString().split('T')[0]} - Chain ${record.chainId}: ${Math.round(record.value)} active addresses`);
    });

    await mongoose.connection.close();
    console.log('\nDatabase connection closed');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkActiveAddressesData();
