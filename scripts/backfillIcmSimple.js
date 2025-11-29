/**
 * Simple ICM/Teleporter data backfill - no rate limiter, verbose logging
 */

require('dotenv').config();

const mongoose = require('mongoose');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { TeleporterMessage } = require('../src/models/teleporterMessage');
const teleporterService = require('../src/services/teleporterService');

// Create HTTP agents with keep-alive
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 120000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 120000
});

/**
 * Find missing dates
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

  return new Set(missingDates);
}

/**
 * Save messages for a date
 */
async function saveMessagesForDate(dateStr, messages) {
  try {
    if (messages.length === 0) {
      return { success: true, messages: 0 };
    }

    const processedData = await teleporterService.processMessages(messages);

    const date = new Date(dateStr);
    date.setHours(23, 59, 59, 999);

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
 * Backfill all messages
 */
async function backfillAllMessages(targetDays) {
  try {
    console.log('Starting to fetch messages from API...\n');

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const oldestTargetDate = new Date(today);
    oldestTargetDate.setDate(today.getDate() - targetDays);
    const oldestTimestamp = Math.floor(oldestTargetDate.getTime() / 1000);

    console.log(`Target range: ${oldestTargetDate.toISOString().split('T')[0]} to ${today.toISOString().split('T')[0]}\n`);

    const missingDates = await findMissingDates(targetDays);
    console.log(`Need to backfill ${missingDates.size} dates\n`);

    if (missingDates.size === 0) {
      console.log('No missing dates!');
      return { success: true, saved: 0 };
    }

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

    console.log('Starting pagination (API is slow, ~9s per request)...\n');

    // Paginate through messages
    do {
      pageCount++;
      console.log(`[Page ${pageCount}] Fetching...`);

      const startTime = Date.now();

      try {
        const params = {
          network: 'mainnet',
          pageSize: 100
        };

        if (nextPageToken) {
          params.pageToken = nextPageToken;
        }

        // Retry logic for connection errors
        let response;
        let retries = 3;
        let lastError;

        for (let i = 0; i < retries; i++) {
          try {
            response = await axios.get(`${process.env.GLACIER_API_BASE}/icm/messages`, {
              headers,
              params,
              timeout: 120000,
              httpAgent,
              httpsAgent
            });
            break; // Success, exit retry loop
          } catch (err) {
            lastError = err;
            if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
              console.log(`[Page ${pageCount}] Connection error (${err.code}), retry ${i + 1}/${retries}...`);
              if (i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // Exponential backoff
                continue;
              }
            }
            throw err; // Non-retryable error or max retries reached
          }
        }

        if (!response) {
          throw lastError;
        }

        const elapsed = Date.now() - startTime;
        const messageList = response.data.messages || [];
        nextPageToken = response.data.nextPageToken;

        console.log(`[Page ${pageCount}] Got ${messageList.length} messages in ${(elapsed/1000).toFixed(1)}s`);

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

          if (timestampInSeconds < oldestTimestamp) {
            reachedTargetDate = true;
            break;
          }

          const messageDate = new Date(timestampInSeconds * 1000);
          const dateStr = messageDate.toISOString().split('T')[0];

          if (missingDates.has(dateStr)) {
            if (!messagesByDate.has(dateStr)) {
              messagesByDate.set(dateStr, []);
            }
            messagesByDate.get(dateStr).push(message);
            totalMessages++;
          }
        }

        console.log(`[Page ${pageCount}] Total collected: ${totalMessages} messages for ${messagesByDate.size} dates`);

        if (reachedTargetDate) {
          console.log(`\n✅ Reached target date!\n`);
          break;
        }

        if (pageCount >= 10000) {
          console.log(`\n⚠️  Reached max pages (10000)\n`);
          break;
        }

      } catch (error) {
        console.error(`[Page ${pageCount}] ❌ Error after retries:`, error.message);
        console.log('Continuing anyway to save collected data...');
        break; // Exit pagination loop, save what we have
      }

    } while (nextPageToken);

    console.log(`\nPagination complete: ${pageCount} pages, ${totalMessages} messages for ${messagesByDate.size} dates\n`);

    // Save data
    console.log('Saving to database...\n');
    const results = [];

    const sortedDates = Array.from(messagesByDate.keys()).sort();
    for (const dateStr of sortedDates) {
      const messages = messagesByDate.get(dateStr);
      const result = await saveMessagesForDate(dateStr, messages);
      results.push({ date: dateStr, ...result });
    }

    // Report missing
    const foundDates = new Set(messagesByDate.keys());
    const notFoundDates = Array.from(missingDates).filter(d => !foundDates.has(d));

    if (notFoundDates.length > 0) {
      console.log(`\n⚠️  No data found for ${notFoundDates.length} dates:`);
      notFoundDates.slice(0, 10).forEach(d => console.log(`  - ${d}`));
      if (notFoundDates.length > 10) {
        console.log(`  ... and ${notFoundDates.length - 10} more`);
      }
    }

    return { success: true, results, saved: messagesByDate.size };

  } catch (error) {
    console.error('Fatal error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Main
 */
async function main() {
  try {
    const days = parseInt(process.argv[2]) || 90;

    console.log('=== Simple ICM/Teleporter Backfill ===');
    console.log(`Target: Last ${days} days\n`);

    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);
    console.log('✅ Connected to database\n');

    const result = await backfillAllMessages(days);

    if (!result.success) {
      console.error('\n❌ Backfill failed:', result.error);
      await mongoose.connection.close();
      process.exit(1);
    }

    console.log('\n=== SUMMARY ===');
    if (result.results) {
      const successful = result.results.filter(r => r.success);
      const failed = result.results.filter(r => !r.success);
      const totalMessages = successful.reduce((sum, r) => sum + (r.messages || 0), 0);

      console.log(`Dates saved: ${successful.length}`);
      console.log(`Failed: ${failed.length}`);
      console.log(`Total messages: ${totalMessages}`);

      if (failed.length > 0) {
        console.log('\nFailed dates:');
        failed.forEach(r => console.log(`  - ${r.date}: ${r.error}`));
      }
    }

    await mongoose.connection.close();
    console.log('\n✅ Done');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
