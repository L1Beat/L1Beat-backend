const mongoose = require('mongoose');
const axios = require('axios');
const ActiveAddresses = require('../src/models/activeAddresses');
const Chain = require('../src/models/chain');
const config = require('../src/config/config');
const logger = require('../src/utils/logger');
require('dotenv').config();

// Rate limiter for API calls
class RateLimiter {
  constructor(maxRequestsPerMinute = 20) {
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
      }, 50);
    } catch (error) {
      console.error('Error in rate limiter:', error);
      this.processing = false;
    }
  }
}

// Use 2000 requests/minute (well within the 125K CUs/minute limit)
const rateLimiter = new RateLimiter(2000);

async function backfillChainActiveAddresses(chainId, dryRun = false) {
  return rateLimiter.enqueue(async () => {
    try {
      console.log(`[${chainId}] Fetching 365 days of active addresses data...`);

      const metricsApiBase = config.api.metrics.baseUrl || process.env.METRICS_API_BASE || 'https://metrics.avax.network/v2';
      const apiKey = process.env.GLACIER_API_KEY;

      const headers = {
        'Accept': 'application/json',
        'User-Agent': 'l1beat-backend',
        'Cache-Control': 'no-cache'
      };

      // Add API key if available
      if (apiKey) {
        headers['x-api-key'] = apiKey;
      }

      const response = await axios.get(
        `${metricsApiBase}/chains/${chainId}/metrics/activeAddresses`,
        {
          params: {
            timeInterval: 'day',
            pageSize: 365
          },
          timeout: config.api.metrics.timeout,
          headers
        }
      );

      if (!response.data || !Array.isArray(response.data.results)) {
        console.log(`[${chainId}] Invalid response format`);
        return { chainId, success: false, error: 'Invalid response' };
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const oneYearAgo = currentTime - (365 * 24 * 60 * 60);

      // Validate data
      const validData = response.data.results.filter(item => {
        const timestamp = Number(item.timestamp);
        const value = parseFloat(item.value);

        if (isNaN(timestamp) || isNaN(value)) {
          return false;
        }

        return timestamp >= oneYearAgo && timestamp <= currentTime;
      });

      console.log(`[${chainId}] Found ${validData.length} valid records`);

      if (dryRun) {
        return { chainId, success: true, records: validData.length, dryRun: true };
      }

      if (validData.length > 0) {
        const result = await ActiveAddresses.bulkWrite(
          validData.map(item => ({
            updateOne: {
              filter: {
                chainId: chainId,
                timestamp: Number(item.timestamp)
              },
              update: {
                $set: {
                  value: parseFloat(item.value),
                  lastUpdated: new Date()
                }
              },
              upsert: true
            }
          })),
          { ordered: false }
        );

        console.log(`[${chainId}] Success: ${result.upsertedCount} new, ${result.modifiedCount} updated`);

        return {
          chainId,
          success: true,
          upserted: result.upsertedCount,
          modified: result.modifiedCount,
          total: validData.length
        };
      }

      return { chainId, success: true, records: 0 };

    } catch (error) {
      console.error(`[${chainId}] Error:`, error.message);
      return { chainId, success: false, error: error.message };
    }
  });
}

async function backfillAllChains(dryRun = false) {
  try {
    // Connect to database
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);
    console.log('Connected to database\n');

    // Get all chains with valid numeric chain IDs
    const chains = await Chain.find({});
    const validChains = chains.filter(chain => {
      const chainId = chain.evmChainId || chain.chainId;
      return chainId && /^\d+$/.test(String(chainId));
    });

    console.log(`Found ${validChains.length} chains with valid numeric IDs\n`);

    if (dryRun) {
      console.log('=== DRY RUN MODE - No data will be written ===\n');
    }

    const results = [];
    let processed = 0;

    for (const chain of validChains) {
      const chainId = String(chain.evmChainId || chain.chainId);
      const result = await backfillChainActiveAddresses(chainId, dryRun);
      results.push(result);
      processed++;

      console.log(`Progress: ${processed}/${validChains.length}\n`);
    }

    // Summary
    console.log('\n=== BACKFILL SUMMARY ===');
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`Total chains: ${validChains.length}`);
    console.log(`Successful: ${successful.length}`);
    console.log(`Failed: ${failed.length}`);

    if (!dryRun) {
      const totalUpserted = successful.reduce((sum, r) => sum + (r.upserted || 0), 0);
      const totalModified = successful.reduce((sum, r) => sum + (r.modified || 0), 0);
      console.log(`New records: ${totalUpserted}`);
      console.log(`Updated records: ${totalModified}`);
    }

    if (failed.length > 0) {
      console.log('\nFailed chains:');
      failed.forEach(r => console.log(`  - Chain ${r.chainId}: ${r.error}`));
    }

    await mongoose.connection.close();
    console.log('\nDatabase connection closed');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

console.log('=== Active Addresses Data Backfill Script ===');
console.log('This will fetch 365 days of active addresses data for all chains\n');

backfillAllChains(dryRun);
