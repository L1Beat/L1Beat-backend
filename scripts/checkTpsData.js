const mongoose = require('mongoose');
const TPS = require('../src/models/tps');
require('dotenv').config();

async function checkTpsData() {
  try {
    // Connect to database
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);
    console.log('Connected to database');

    // Get the oldest and newest TPS records
    const oldestRecord = await TPS.findOne().sort({ timestamp: 1 }).lean();
    const newestRecord = await TPS.findOne().sort({ timestamp: -1 }).lean();

    if (!oldestRecord || !newestRecord) {
      console.log('No TPS data found in database');
      process.exit(0);
    }

    const oldestDate = new Date(oldestRecord.timestamp * 1000);
    const newestDate = new Date(newestRecord.timestamp * 1000);
    const daysDiff = Math.floor((newestRecord.timestamp - oldestRecord.timestamp) / (24 * 60 * 60));

    console.log('\n=== TPS Data Summary ===');
    console.log('Oldest record:', oldestDate.toISOString());
    console.log('Newest record:', newestDate.toISOString());
    console.log('Days of data:', daysDiff);
    console.log('Total records:', await TPS.countDocuments());

    // Get data per chain
    const chainStats = await TPS.aggregate([
      {
        $group: {
          _id: '$chainId',
          count: { $sum: 1 },
          oldestTimestamp: { $min: '$timestamp' },
          newestTimestamp: { $max: '$timestamp' }
        }
      },
      { $sort: { count: -1 } }
    ]);

    console.log('\n=== Data per Chain ===');
    chainStats.forEach(stat => {
      const days = Math.floor((stat.newestTimestamp - stat.oldestTimestamp) / (24 * 60 * 60));
      console.log(`Chain ${stat._id}: ${stat.count} records, ${days} days (${new Date(stat.oldestTimestamp * 1000).toISOString().split('T')[0]} to ${new Date(stat.newestTimestamp * 1000).toISOString().split('T')[0]})`);
    });

    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkTpsData();
