const FeesPaid = require('../models/feesPaid');
const axios = require('axios');
const Chain = require('../models/chain');
const config = require('../config/config');
const logger = require('../utils/logger');

// Rate limiter implementation
class RateLimiter {
  constructor(maxRequestsPerMinute = 30) {
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

        logger.info(`Rate limit reached, waiting ${Math.round(timeToWait/1000)}s before next request`);

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
      }, 300);
    } catch (error) {
      logger.error('Error in rate limiter:', error);
      this.processing = false;
    }
  }
}

const metricsApiRateLimiter = new RateLimiter(config.api.metrics.rateLimit.requestsPerMinute || 20);

class FeesPaidService {
  async updateFeesPaidData(chainId, retryCount = config.api.metrics.rateLimit.maxRetries || 3) {
    return metricsApiRateLimiter.enqueue(async () => {
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          logger.info(`[FeesPaid Update] Starting update for chain ${chainId} (Attempt ${attempt}/${retryCount})`);

          const headers = {
            'Accept': 'application/json',
            'User-Agent': 'l1beat-backend',
            'Cache-Control': 'no-cache'
          };

          if (process.env.GLACIER_API_KEY) {
            headers['x-api-key'] = process.env.GLACIER_API_KEY;
          }

          const response = await axios.get(`${config.api.metrics.baseUrl}/chains/${chainId}/metrics/feesPaid`, {
            params: {
              timeInterval: 'day',
              pageSize: 100  // Maximum allowed by API
            },
            timeout: config.api.metrics.timeout,
            headers
          });

          if (!response.data || !Array.isArray(response.data.results)) {
            logger.warn(`[FeesPaid Update] Invalid response format for chain ${chainId}`);
            continue;
          }

          const currentTime = Math.floor(Date.now() / 1000);
          const thirtyDaysAgo = currentTime - (30 * 24 * 60 * 60);

          const validData = response.data.results.filter(item => {
            const timestamp = Number(item.timestamp);
            const value = parseFloat(item.value);

            if (isNaN(timestamp) || isNaN(value)) {
              return false;
            }

            return timestamp >= thirtyDaysAgo && timestamp <= currentTime;
          });

          if (validData.length > 0) {
            const result = await FeesPaid.bulkWrite(
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

            logger.info(`[FeesPaid Update] Updated chain ${chainId}:`, {
              upserted: result.upsertedCount,
              modified: result.modifiedCount,
              total: validData.length
            });

            return {
              success: true,
              chainId,
              recordsProcessed: validData.length,
              upserted: result.upsertedCount,
              modified: result.modifiedCount
            };
          }

          logger.info(`[FeesPaid Update] No valid data for chain ${chainId}`);
          return {
            success: true,
            chainId,
            recordsProcessed: 0,
            message: 'No valid data points'
          };

        } catch (error) {
          logger.error(`[FeesPaid Update] Error for chain ${chainId} (Attempt ${attempt}/${retryCount}):`, error.message);

          if (attempt === retryCount) {
            return {
              success: false,
              chainId,
              error: error.message
            };
          }

          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    });
  }

  async updateAllChainsFeesPaid() {
    try {
      logger.info('[FeesPaid] Starting update for all chains');

      const chains = await Chain.find({});
      const results = [];

      for (const chain of chains) {
        const chainId = chain.evmChainId || chain.chainId;

        if (!chainId || !/^\d+$/.test(String(chainId))) {
          logger.warn(`[FeesPaid] Skipping chain with invalid ID:`, chain.name);
          continue;
        }

        const result = await this.updateFeesPaidData(String(chainId));
        results.push(result);
      }

      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      logger.info('[FeesPaid] Update completed:', {
        total: chains.length,
        successful,
        failed
      });

      return { success: true, results };
    } catch (error) {
      logger.error('[FeesPaid] Error updating all chains:', error);
      return { success: false, error: error.message };
    }
  }

  async getFeesPaidHistory(chainId, days = 30) {
    try {
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = endTime - (days * 24 * 60 * 60);

      const data = await FeesPaid.find({
        chainId: String(chainId),
        timestamp: { $gte: startTime, $lte: endTime }
      })
        .sort({ timestamp: 1 })
        .lean();

      return data;
    } catch (error) {
      logger.error(`[FeesPaid] Error fetching history for chain ${chainId}:`, error);
      throw error;
    }
  }

  async getLatestFeesPaid(chainId) {
    try {
      const latestRecord = await FeesPaid.findOne({
        chainId: String(chainId)
      })
        .sort({ timestamp: -1 })
        .lean();

      return latestRecord;
    } catch (error) {
      logger.error(`[FeesPaid] Error fetching latest for chain ${chainId}:`, error);
      throw error;
    }
  }

  async getNetworkFeesPaidHistory(days = 30) {
    try {
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = endTime - (days * 24 * 60 * 60);

      const data = await FeesPaid.find({
        timestamp: { $gte: startTime, $lte: endTime }
      })
        .sort({ timestamp: 1 })
        .lean();

      // Group by timestamp and sum fees paid
      const groupedData = {};
      data.forEach(record => {
        if (!groupedData[record.timestamp]) {
          groupedData[record.timestamp] = {
            timestamp: record.timestamp,
            value: 0
          };
        }
        groupedData[record.timestamp].value += record.value;
      });

      return Object.values(groupedData).sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
      logger.error('[FeesPaid] Error fetching network history:', error);
      throw error;
    }
  }

  async getNetworkLatestFeesPaid() {
    try {
      // Get the most recent timestamp
      const latestRecord = await FeesPaid.findOne()
        .sort({ timestamp: -1 })
        .lean();

      if (!latestRecord) {
        return null;
      }

      const latestTimestamp = latestRecord.timestamp;

      // Get all records for that timestamp and sum them
      const records = await FeesPaid.find({
        timestamp: latestTimestamp
      }).lean();

      const totalFeesPaid = records.reduce((sum, record) => sum + record.value, 0);

      return {
        timestamp: latestTimestamp,
        value: totalFeesPaid,
        chainCount: records.length
      };
    } catch (error) {
      logger.error('[FeesPaid] Error fetching network latest:', error);
      throw error;
    }
  }
}

module.exports = new FeesPaidService();
