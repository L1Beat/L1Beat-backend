const mongoose = require('mongoose');
const { TeleporterMessage } = require('../src/models/teleporterMessage');
require('dotenv').config();

async function checkIcmData() {
  try {
    // Connect to database
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);
    console.log('Connected to database');

    // Get the oldest and newest ICM records
    const oldestRecord = await TeleporterMessage.findOne({ dataType: 'daily' }).sort({ updatedAt: 1 }).lean();
    const newestRecord = await TeleporterMessage.findOne({ dataType: 'daily' }).sort({ updatedAt: -1 }).lean();

    if (!oldestRecord || !newestRecord) {
      console.log('No ICM/Teleporter data found in database');
      process.exit(0);
    }

    const oldestDate = new Date(oldestRecord.updatedAt);
    const newestDate = new Date(newestRecord.updatedAt);
    const daysDiff = Math.floor((newestDate - oldestDate) / (24 * 60 * 60 * 1000));

    console.log('\n=== ICM/Teleporter Data Summary ===');
    console.log('Oldest record:', oldestDate.toISOString());
    console.log('Newest record:', newestDate.toISOString());
    console.log('Days of data:', daysDiff);
    console.log('Total daily records:', await TeleporterMessage.countDocuments({ dataType: 'daily' }));
    console.log('Total weekly records:', await TeleporterMessage.countDocuments({ dataType: 'weekly' }));

    // Get recent records
    const recentRecords = await TeleporterMessage.find({ dataType: 'daily' })
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean();

    console.log('\n=== Recent Daily Records ===');
    recentRecords.forEach(record => {
      const date = new Date(record.updatedAt);
      console.log(`${date.toISOString().split('T')[0]}: ${record.totalMessages} messages, ${record.messageCounts?.length || 0} chain pairs`);
    });

    // Check for gaps in the data
    console.log('\n=== Checking for Data Gaps ===');
    const allRecords = await TeleporterMessage.find({ dataType: 'daily' })
      .sort({ updatedAt: 1 })
      .select('updatedAt')
      .lean();

    let gaps = [];
    for (let i = 1; i < allRecords.length; i++) {
      const prev = new Date(allRecords[i - 1].updatedAt);
      const curr = new Date(allRecords[i].updatedAt);
      const daysDiff = Math.floor((curr - prev) / (24 * 60 * 60 * 1000));

      if (daysDiff > 1) {
        gaps.push({
          from: prev.toISOString().split('T')[0],
          to: curr.toISOString().split('T')[0],
          days: daysDiff - 1
        });
      }
    }

    if (gaps.length > 0) {
      console.log(`Found ${gaps.length} gaps in the data:`);
      gaps.forEach(gap => {
        console.log(`  Gap: ${gap.from} to ${gap.to} (${gap.days} missing days)`);
      });
    } else {
      console.log('No gaps found - data is continuous!');
    }

    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkIcmData();
