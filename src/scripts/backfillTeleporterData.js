/**
 * Script to backfill missing teleporter message data
 * This script analyzes the existing teleporter data and fills in gaps by fetching
 * historical data from the Glacier API for days that are missing.
 * 
 * Usage: node src/scripts/backfillTeleporterData.js --days=30 --db=mongodb://localhost:27017/l1beat
 */

// Load environment variables first before other imports
require('dotenv').config();

const mongoose = require('mongoose');
const axios = require('axios');
const config = require('../config/config');
const { TeleporterMessage } = require('../models/teleporterMessage');
const teleporterService = require('../services/teleporterService');
const logger = require('../utils/logger');

// Parse command line arguments
const args = process.argv.slice(2).reduce((result, arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  result[key] = value;
  return result;
}, {});

const days = parseInt(args.days || 30);
const dbUri = args.db; // Optional DB URI from command line

/**
 * Connect to the database
 */
async function connectDatabase() {
  try {
    // Use DB URI in this priority: command line arg > config > environment variables
    const connectionUri = dbUri || config.db.uri;
    
    // Check if the database URI is defined
    if (!connectionUri) {
      logger.error('Database URI is undefined. Make sure your environment variables are set correctly.');
      logger.info('You can specify the database URI directly: node src/scripts/backfillTeleporterData.js --days=30 --db=mongodb://username:password@localhost:27017/dbname');
      
      // Use fallback URI if available in environment
      const fallbackUri = process.env.MONGODB_URI || process.env.DB_URI || process.env.DATABASE_URL;
      if (fallbackUri) {
        logger.info(`Attempting to use fallback database URI from environment variables`);
        await mongoose.connect(fallbackUri, config.db.options);
        logger.info('Database connection established using fallback URI');
        return true;
      }
      
      // Print connection example
      logger.info('Examples:');
      logger.info('  Local: --db=mongodb://localhost:27017/l1beat');
      logger.info('  Atlas: --db=mongodb+srv://username:password@cluster.mongodb.net/l1beat');
      
      return false;
    }
    
    logger.info(`Connecting to database at ${connectionUri}`);
    await mongoose.connect(connectionUri, config.db.options);
    logger.info('Database connection established');
    
    // Log detailed connection info
    logger.info(`🗄️  Connected to database: ${mongoose.connection.db.databaseName}`);
    logger.info(`🌐 Connection host: ${mongoose.connection.host}:${mongoose.connection.port}`);
    logger.info(`📝 Connection ready state: ${mongoose.connection.readyState}`);
    
    return true;
  } catch (error) {
    logger.error('Failed to connect to database:', { error: error.message });
    return false;
  }
}

/**
 * Find missing dates in the teleporter data
 * @param {number} days - Number of days to check
 * @returns {Promise<Array>} Array of missing dates (as Date objects)
 */
async function findMissingDates(days) {
  // Get all daily teleporter data
  const existingData = await TeleporterMessage.find({
    dataType: 'daily'
  }).sort({ updatedAt: -1 });
  
  logger.info(`📊 Found ${existingData.length} existing daily records in database`);
  
  // Create a map of existing dates (YYYY-MM-DD)
  const existingDates = {};
  existingData.forEach(record => {
    const date = new Date(record.updatedAt);
    const dateStr = `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
    existingDates[dateStr] = true;
    logger.info(`📅 Existing date found: ${dateStr} (${record.totalMessages} messages, ${record.messageCounts?.length || 0} chain pairs)`);
  });
  
  // Find the most recent date
  const mostRecentDate = existingData.length > 0 ? new Date(existingData[0].updatedAt) : new Date();
  logger.info(`🕒 Most recent date in DB: ${mostRecentDate.toISOString()}`);
  
  // Check for missing dates in the specified range
  const missingDates = [];
  for (let i = 0; i < days; i++) {
    const currentDate = new Date(mostRecentDate);
    currentDate.setDate(mostRecentDate.getDate() - i);
    
    const dateStr = `${currentDate.getFullYear()}-${(currentDate.getMonth()+1).toString().padStart(2, '0')}-${currentDate.getDate().toString().padStart(2, '0')}`;
    
    // If this date doesn't exist in our database, add it to the missing dates
    if (!existingDates[dateStr]) {
      logger.info(`❌ Missing date detected: ${dateStr}`);
      missingDates.push({
        date: new Date(currentDate),
        dateString: dateStr
      });
    } else {
      logger.info(`✅ Date exists: ${dateStr}`);
    }
  }
  
  return missingDates;
}

/**
 * Fetch and store teleporter data for a specific date
 * @param {Date} date - Date to fetch data for
 * @returns {Promise<boolean>} Success status
 */
async function backfillDateData(date) {
  try {
    // Create the start and end of the target day (24-hour window)
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0); // Start of day (00:00:00)
    
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999); // End of day (23:59:59)
    
    // Convert to Unix timestamps (seconds)
    const startTime = Math.floor(dayStart.getTime() / 1000);
    const endTime = Math.floor(dayEnd.getTime() / 1000);
    
    logger.info(`Backfilling data for ${date.toISOString().split('T')[0]} (${dayStart.toISOString()} to ${dayEnd.toISOString()})`);
    
    // Start fetching from recent messages and go backwards until we find messages from this day
    let allDayMessages = [];
    let nextPageToken = null;
    let pageCount = 0;
    let reachedTargetDay = false;
    let passedTargetDay = false;
    
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'l1beat-backend'
    };
    
    if (process.env.GLACIER_API_KEY) {
      headers['x-glacier-api-key'] = process.env.GLACIER_API_KEY;
    }
    
    do {
      pageCount++;
      
      const params = {
        network: 'mainnet',
        pageSize: 100
      };
      
      if (nextPageToken) {
        params.pageToken = nextPageToken;
      }
      
      logger.info(`Fetching page ${pageCount} for ${date.toISOString().split('T')[0]}`);
      
      const response = await axios.get(`${process.env.GLACIER_API_BASE}/icm/messages`, {
        headers,
        params,
        timeout: 30000
      });
      
      const data = response.data;
      const messages = data.messages || [];
      nextPageToken = data.nextPageToken;
      
      // Filter messages for our target day
      for (const message of messages) {
        let messageTimestamp = null;
        
        // Try to get timestamp from sourceTransaction first, then fallback to message timestamp
        if (message.sourceTransaction && message.sourceTransaction.timestamp) {
          messageTimestamp = message.sourceTransaction.timestamp;
        } else if (message.timestamp) {
          messageTimestamp = message.timestamp;
        }
        
        if (!messageTimestamp) {
          continue; // Skip messages without timestamps
        }
        
        // Convert timestamp to seconds if it's in milliseconds
        const timestampInSeconds = messageTimestamp > 1000000000000 
          ? Math.floor(messageTimestamp / 1000) 
          : messageTimestamp;
        
        // Check if this message is from our target day
        if (timestampInSeconds >= startTime && timestampInSeconds <= endTime) {
          allDayMessages.push(message);
          reachedTargetDay = true;
        } else if (timestampInSeconds < startTime) {
          // We've passed our target day (gone too far back), stop
          passedTargetDay = true;
          break;
        }
      }
      
      logger.info(`Page ${pageCount}: ${messages.length} messages, ${allDayMessages.length} from target day`);
      
      // Stop if we've passed the target day or hit limits
      if (passedTargetDay || pageCount >= 1000) {
        break;
      }
      
      // Add delay between requests
      if (nextPageToken) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } while (nextPageToken);
    
    if (allDayMessages.length === 0) {
      logger.warn(`No messages found for ${date.toISOString().split('T')[0]}`);
      return false;
    }
    
    logger.info(`Found ${allDayMessages.length} messages for ${date.toISOString().split('T')[0]}`);
    
    // Process the messages
    const processedData = await teleporterService.processMessages(allDayMessages);
    
    // Create a timestamp at the end of the target day
    const timestamp = new Date(date);
    timestamp.setHours(23, 59, 59, 999);
    
    // Save the data to the database
    const teleporterData = new TeleporterMessage({
      updatedAt: timestamp,
      messageCounts: processedData,
      totalMessages: allDayMessages.length,
      timeWindow: 24,
      dataType: 'daily'
    });
    
    logger.info(`💾 About to save to database: ${mongoose.connection.db.databaseName} collection: ${TeleporterMessage.collection.name}`);
    logger.info(`📊 Saving data for ${date.toISOString().split('T')[0]}:`, {
      timestamp: timestamp.toISOString(),
      totalMessages: allDayMessages.length,
      chainPairs: processedData.length,
      dataType: 'daily',
      timeWindow: 24,
      sampleChainPair: processedData[0] || null
    });
    
    await teleporterData.save();
    
    logger.info(`✅ Successfully saved to MongoDB! Document ID: ${teleporterData._id}`);
    logger.info(`✅ Saved teleporter data for ${date.toISOString().split('T')[0]} with ${processedData.length} chain pairs and ${allDayMessages.length} total messages`);
    return true;
    
  } catch (error) {
    logger.error(`❌ Error backfilling data for ${date.toISOString().split('T')[0]}:`, { 
      error: error.message,
      stack: error.stack
    });
    return false;
  }
}

/**
 * Main function to run the backfill
 */
async function main() {
  try {
    // Connect to the database
    const connected = await connectDatabase();
    if (!connected) {
      process.exit(1);
    }
    
    // Find missing dates
    const missingDates = await findMissingDates(days);
    
    if (missingDates.length === 0) {
      logger.info(`No missing dates found in the last ${days} days`);
      await mongoose.connection.close();
      return;
    }
    
    logger.info(`Found ${missingDates.length} missing dates: ${missingDates.map(d => d.dateString).join(', ')}`);
    
    // Backfill each missing date
    let successCount = 0;
    for (const { date, dateString } of missingDates) {
      logger.info(`Processing missing date: ${dateString}`);
      const success = await backfillDateData(date);
      
      if (success) {
        successCount++;
      }
      
      // Add a delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    logger.info(`Backfill complete. Successfully backfilled ${successCount}/${missingDates.length} dates.`);
    
    // Close the database connection
    await mongoose.connection.close();
    
  } catch (error) {
    logger.error('Error in backfill process:', { error: error.message, stack: error.stack });
    
    // Ensure database connection is closed
    try {
      await mongoose.connection.close();
    } catch (err) {
      // Ignore
    }
    
    process.exit(1);
  }
}

// Run the script
main(); 