/**
 * Fast ICM/Teleporter data backfill script using high API rate limits
 * Based on successful TPS backfill approach
 */

require('dotenv').config();

const mongoose = require('mongoose');
const axios = require('axios');
const { TeleporterMessage } = require('../src/models/teleporterMessage');
const teleporterService = require('../src/services/teleporterService');

// Rate limiter for API calls (using user's high limits)
class RateLimiter {
  constructor(maxRequestsPerMinute = 5000) {
    this.queue = [];
    this.processing = false;
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.requestTimestamps = [];
  }

  async enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    try {
      const now = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(
        timestamp => now - timestamp < 60000
      );

      if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
        const oldestTimestamp = this.requestTimestamps[0];
        const timeToWait = 60000 - (now - oldestTimestamp);

        console.log(`Rate limit reached, waiting ${Math.round(timeToWait/1000)}s...`);

        setTimeout(() => {
          this.processing = false;
          this.processQueue();
        }, timeToWait + 100);

        return;
      }

      const item = this.queue.shift();
      this.requestTimestamps.push(now);

      try {
        const result = await item.fn();
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }

      setTimeout(() => {
        this.processing = false;
        this.processQueue();
      }, 30); // Optimized delay for maximum speed
    } catch (error) {
      console.error('Error in rate limiter:', error);
      this.processing = false;
    }
  }
}

const rateLimiter = new RateLimiter(5000); // 5000 req/min (well within 125K CUs/min limit)

/**
 * Fetch messages for a specific date
 */
async function fetchMessagesForDate(date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);

  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const startTime = Math.floor(dayStart.getTime() / 1000);
  const endTime = Math.floor(dayEnd.getTime() / 1000);

  console.log(`[${date.toISOString().split('T')[0]}] Fetching messages...`);

  let allDayMessages = [];
  let nextPageToken = null;
  let pageCount = 0;
  let passedTargetDay = false;

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'l1beat-backend'
  };

  if (process.env.GLACIER_API_KEY) {
    headers['x-glacier-api-key'] = process.env.GLACIER_API_KEY;
  }

  do {
    const messages = await rateLimiter.enqueue(async () => {
      pageCount++;

      const params = {
        network: 'mainnet',
        pageSize: 100
      };

      if (nextPageToken) {
        params.pageToken = nextPageToken;
      }

      const response = await axios.get(`${process.env.GLACIER_API_BASE}/icm/messages`, {
        headers,
        params,
        timeout: 120000 // 2 minutes timeout for large paginations
      });

      return response.data;
    });

    const messageList = messages.messages || [];
    nextPageToken = messages.nextPageToken;

    // Filter messages for our target day
    for (const message of messageList) {
      let messageTimestamp = null;

      if (message.sourceTransaction && message.sourceTransaction.timestamp) {
        messageTimestamp = message.sourceTransaction.timestamp;
      } else if (message.timestamp) {
        messageTimestamp = message.timestamp;
      }

      if (!messageTimestamp) continue;

      const timestampInSeconds = messageTimestamp > 1000000000000
        ? Math.floor(messageTimestamp / 1000)
        : messageTimestamp;

      if (timestampInSeconds >= startTime && timestampInSeconds <= endTime) {
        allDayMessages.push(message);
      } else if (timestampInSeconds < startTime) {
        passedTargetDay = true;
        break;
      }
    }

    if (pageCount % 50 === 0) {
      console.log(`[${date.toISOString().split('T')[0]}] Page ${pageCount}: ${allDayMessages.length} messages found so far`);
    }

    if (passedTargetDay || pageCount >= 1000) {
      break;
    }

  } while (nextPageToken);

  console.log(`[${date.toISOString().split('T')[0]}] Total: ${allDayMessages.length} messages, ${pageCount} pages`);

  return allDayMessages;
}

/**
 * Process and save messages for a date
 */
async function backfillDate(date) {
  try {
    const messages = await fetchMessagesForDate(date);

    if (messages.length === 0) {
      console.log(`[${date.toISOString().split('T')[0]}] No messages found`);
      return { success: true, messages: 0 };
    }

    // Process the messages
    const processedData = await teleporterService.processMessages(messages);

    // Create timestamp at end of day
    const timestamp = new Date(date);
    timestamp.setHours(23, 59, 59, 999);

    // Save to database
    const teleporterData = new TeleporterMessage({
      updatedAt: timestamp,
      messageCounts: processedData,
      totalMessages: messages.length,
      timeWindow: 24,
      dataType: 'daily'
    });

    await teleporterData.save();

    console.log(`[${date.toISOString().split('T')[0]}] ✅ Saved: ${messages.length} messages, ${processedData.length} chain pairs`);

    return { success: true, messages: messages.length, chainPairs: processedData.length };

  } catch (error) {
    console.error(`[${date.toISOString().split('T')[0]}] ❌ Error:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Find missing dates in the last N days
 */
async function findMissingDates(days) {
  const existingData = await TeleporterMessage.find({ dataType: 'daily' })
    .sort({ updatedAt: -1 })
    .lean();

  console.log(`\n📊 Found ${existingData.length} existing daily records`);

  const existingDates = new Set();
  existingData.forEach(record => {
    const date = new Date(record.updatedAt);
    const dateStr = date.toISOString().split('T')[0];
    existingDates.add(dateStr);
  });

  const missingDates = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < days; i++) {
    const currentDate = new Date(today);
    currentDate.setDate(today.getDate() - i);

    const dateStr = currentDate.toISOString().split('T')[0];

    if (!existingDates.has(dateStr)) {
      missingDates.push(currentDate);
    }
  }

  return missingDates.reverse(); // Oldest first
}

/**
 * Main backfill function
 */
async function main() {
  try {
    const days = parseInt(process.argv[2]) || 90;

    console.log('=== Fast ICM/Teleporter Data Backfill ===');
    console.log(`Checking last ${days} days for missing data\n`);

    // Connect to database
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);
    console.log('✅ Connected to database\n');

    // Find missing dates
    const missingDates = await findMissingDates(days);

    if (missingDates.length === 0) {
      console.log(`\n✅ No missing dates found in the last ${days} days`);
      await mongoose.connection.close();
      return;
    }

    console.log(`\n❌ Found ${missingDates.length} missing dates:`);
    missingDates.forEach(d => console.log(`  - ${d.toISOString().split('T')[0]}`));
    console.log('');

    // Backfill missing dates
    const results = [];
    for (const date of missingDates) {
      const result = await backfillDate(date);
      results.push(result);
    }

    // Summary
    console.log('\n=== BACKFILL SUMMARY ===');
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`Total dates: ${missingDates.length}`);
    console.log(`Successful: ${successful.length}`);
    console.log(`Failed: ${failed.length}`);

    const totalMessages = successful.reduce((sum, r) => sum + (r.messages || 0), 0);
    console.log(`Total messages: ${totalMessages}`);

    if (failed.length > 0) {
      console.log('\nFailed dates:');
      failed.forEach(r => console.log(`  - ${r.error}`));
    }

    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
