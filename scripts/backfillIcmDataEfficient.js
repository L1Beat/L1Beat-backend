/**
 * Efficient ICM/Teleporter data backfill script
 * Instead of fetching each date separately, this paginates through ALL messages once
 * and groups them by date, saving as we go.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const axios = require('axios');
const { TeleporterMessage } = require('../src/models/teleporterMessage');
const teleporterService = require('../src/services/teleporterService');

// Rate limiter for API calls
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
      }, 30);
    } catch (error) {
      console.error('Error in rate limiter:', error);
      this.processing = false;
    }
  }
}

const rateLimiter = new RateLimiter(5000);

/**
 * Find missing dates in the last N days
 */
async function findMissingDates(days) {
  const existingData = await TeleporterMessage.find({ dataType: 'daily' })
    .sort({ updatedAt: -1 })
    .lean();

  console.log(`📊 Found ${existingData.length} existing daily records`);

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
      missingDates.push(dateStr);
    }
  }

  return new Set(missingDates); // Return as Set for O(1) lookups
}

/**
 * Process and save messages for a specific date
 */
async function saveMessagesForDate(dateStr, messages) {
  try {
    if (messages.length === 0) {
      console.log(`[${dateStr}] No messages to save`);
      return { success: true, messages: 0 };
    }

    // Process the messages
    const processedData = await teleporterService.processMessages(messages);

    // Create timestamp at end of day
    const date = new Date(dateStr);
    date.setHours(23, 59, 59, 999);

    // Save to database
    const teleporterData = new TeleporterMessage({
      updatedAt: date,
      messageCounts: processedData,
      totalMessages: messages.length,
      timeWindow: 24,
      dataType: 'daily'
    });

    await teleporterData.save();

    console.log(`[${dateStr}] ✅ Saved: ${messages.length} messages, ${processedData.length} chain pairs`);

    return { success: true, messages: messages.length, chainPairs: processedData.length };

  } catch (error) {
    console.error(`[${dateStr}] ❌ Error:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Fetch all messages and group by date
 */
async function backfillAllMessages(targetDays) {
  try {
    console.log('Starting to fetch messages from API...\n');

    // Calculate the oldest date we care about
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const oldestTargetDate = new Date(today);
    oldestTargetDate.setDate(today.getDate() - targetDays);
    const oldestTimestamp = Math.floor(oldestTargetDate.getTime() / 1000);

    console.log(`Target date range: ${oldestTargetDate.toISOString().split('T')[0]} to ${today.toISOString().split('T')[0]}\n`);

    // Find which dates we need to backfill
    const missingDates = await findMissingDates(targetDays);
    console.log(`Need to backfill ${missingDates.size} dates\n`);

    if (missingDates.size === 0) {
      console.log('No missing dates to backfill!');
      return { success: true, saved: 0 };
    }

    // Group messages by date
    const messagesByDate = new Map();
    let nextPageToken = null;
    let pageCount = 0;
    let totalMessages = 0;
    let reachedTargetDate = false;

    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'l1beat-backend'
    };

    if (process.env.GLACIER_API_KEY) {
      headers['x-glacier-api-key'] = process.env.GLACIER_API_KEY;
    }

    console.log('Starting pagination...\n');

    // Paginate through all messages
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
          timeout: 120000
        });

        return response.data;
      });

      const messageList = messages.messages || [];
      nextPageToken = messages.nextPageToken;

      // Group messages by date
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

        // Check if we've gone past our target date range
        if (timestampInSeconds < oldestTimestamp) {
          reachedTargetDate = true;
          break;
        }

        // Get the date string for this message
        const messageDate = new Date(timestampInSeconds * 1000);
        const dateStr = messageDate.toISOString().split('T')[0];

        // Only collect messages for dates we need to backfill
        if (missingDates.has(dateStr)) {
          if (!messagesByDate.has(dateStr)) {
            messagesByDate.set(dateStr, []);
          }
          messagesByDate.get(dateStr).push(message);
          totalMessages++;
        }
      }

      // Log progress every 10 pages
      if (pageCount % 10 === 0) {
        console.log(`Progress: Page ${pageCount}, ${totalMessages} messages collected for ${messagesByDate.size} dates`);
      }

      // Stop if we've reached our target date or gone too far
      if (reachedTargetDate || pageCount >= 10000) {
        console.log(`\nStopping pagination: ${reachedTargetDate ? 'Reached target date' : 'Max pages reached'}\n`);
        break;
      }

    } while (nextPageToken);

    console.log(`\nCompleted pagination: ${pageCount} pages, ${totalMessages} messages for ${messagesByDate.size} dates\n`);

    // Save all collected data
    console.log('Saving data to database...\n');
    const results = [];

    // Sort dates and save them
    const sortedDates = Array.from(messagesByDate.keys()).sort();
    for (const dateStr of sortedDates) {
      const messages = messagesByDate.get(dateStr);
      const result = await saveMessagesForDate(dateStr, messages);
      results.push({ date: dateStr, ...result });
    }

    // Check for dates we didn't find any data for
    const foundDates = new Set(messagesByDate.keys());
    const notFoundDates = Array.from(missingDates).filter(d => !foundDates.has(d));

    if (notFoundDates.length > 0) {
      console.log(`\n⚠️  No data found for ${notFoundDates.length} dates (likely no messages on these days):`);
      notFoundDates.slice(0, 10).forEach(d => console.log(`  - ${d}`));
      if (notFoundDates.length > 10) {
        console.log(`  ... and ${notFoundDates.length - 10} more`);
      }
    }

    return { success: true, results, saved: messagesByDate.size };

  } catch (error) {
    console.error('Error during backfill:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Main function
 */
async function main() {
  try {
    const days = parseInt(process.argv[2]) || 90;

    console.log('=== Efficient ICM/Teleporter Data Backfill ===');
    console.log(`Checking last ${days} days for missing data\n`);

    // Connect to database
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);
    console.log('✅ Connected to database\n');

    // Run backfill
    const result = await backfillAllMessages(days);

    if (!result.success) {
      console.error('\n❌ Backfill failed:', result.error);
      await mongoose.connection.close();
      process.exit(1);
    }

    // Summary
    console.log('\n=== BACKFILL SUMMARY ===');
    if (result.results) {
      const successful = result.results.filter(r => r.success);
      const failed = result.results.filter(r => !r.success);
      const totalMessages = successful.reduce((sum, r) => sum + (r.messages || 0), 0);

      console.log(`Dates processed: ${result.results.length}`);
      console.log(`Successful: ${successful.length}`);
      console.log(`Failed: ${failed.length}`);
      console.log(`Total messages: ${totalMessages}`);

      if (failed.length > 0) {
        console.log('\nFailed dates:');
        failed.forEach(r => console.log(`  - ${r.date}: ${r.error}`));
      }
    }

    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
