const AvgGasPrice = require('../models/avgGasPrice');
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

class AvgGasPriceService {
  async updateAvgGasPriceData(chainId, retryCount = config.api.metrics.rateLimit.maxRetries || 3) {
    return metricsApiRateLimiter.enqueue(async () => {
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          logger.info(`[AvgGasPrice Update] Starting update for chain ${chainId} (Attempt ${attempt}/${retryCount})`);

          const headers = {
            'Accept': 'application/json',
            'User-Agent': 'l1beat-backend',
            'Cache-Control': 'no-cache'
          };

          if (process.env.GLACIER_API_KEY) {
            headers['x-api-key'] = process.env.GLACIER_API_KEY;
          }

          const response = await axios.get(`${config.api.metrics.baseUrl}/chains/${chainId}/metrics/avgGasPrice`, {
            params: {
              timeInterval: 'day',
              pageSize: 30
            },
            timeout: config.api.metrics.timeout,
            headers
          });

          if (!response.data || !Array.isArray(response.data.results)) {
            logger.warn(`[AvgGasPrice Update] Invalid response format for chain ${chainId}`);
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
            const result = await AvgGasPrice.bulkWrite(
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

            logger.info(`[AvgGasPrice Update] Updated chain ${chainId}:`, {
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

          logger.info(`[AvgGasPrice Update] No valid data for chain ${chainId}`);
          return {
            success: true,
            chainId,
            recordsProcessed: 0,
            message: 'No valid data points'
          };

        } catch (error) {
          logger.error(`[AvgGasPrice Update] Error for chain ${chainId} (Attempt ${attempt}/${retryCount}):`, error.message);

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

  async updateAllChainsAvgGasPrice() {
    try {
      logger.info('[AvgGasPrice] Starting update for all chains');

      const chains = await Chain.find({});
      const results = [];

      for (const chain of chains) {
        const chainId = chain.evmChainId || chain.chainId;

        if (!chainId || !/^\d+$/.test(String(chainId))) {
          logger.warn(`[AvgGasPrice] Skipping chain with invalid ID:`, chain.name);
          continue;
        }

        const result = await this.updateAvgGasPriceData(String(chainId));
        results.push(result);
      }

      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      logger.info('[AvgGasPrice] Update completed:', {
        total: chains.length,
        successful,
        failed
      });

      return { success: true, results };
    } catch (error) {
      logger.error('[AvgGasPrice] Error updating all chains:', error);
      return { success: false, error: error.message };
    }
  }

  async getAvgGasPriceHistory(chainId, days = 30) {
    try {
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = endTime - (days * 24 * 60 * 60);

      const data = await AvgGasPrice.find({
        chainId: String(chainId),
        timestamp: { $gte: startTime, $lte: endTime }
      })
        .sort({ timestamp: 1 })
        .lean();

      return data;
    } catch (error) {
      logger.error(`[AvgGasPrice] Error fetching history for chain ${chainId}:`, error);
      throw error;
    }
  }

  async getLatestAvgGasPrice(chainId) {
    try {
      const latestRecord = await AvgGasPrice.findOne({
        chainId: String(chainId)
      })
        .sort({ timestamp: -1 })
        .lean();

      return latestRecord;
    } catch (error) {
      logger.error(`[AvgGasPrice] Error fetching latest for chain ${chainId}:`, error);
      throw error;
    }
  }

  async getNetworkAvgGasPriceHistory(days = 30) {
    try {
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = endTime - (days * 24 * 60 * 60);

      const data = await AvgGasPrice.find({
        timestamp: { $gte: startTime, $lte: endTime }
      })
        .sort({ timestamp: 1 })
        .lean();

      // Group by timestamp and calculate weighted average
      const groupedData = {};
      data.forEach(record => {
        if (!groupedData[record.timestamp]) {
          groupedData[record.timestamp] = {
            timestamp: record.timestamp,
            sum: 0,
            count: 0
          };
        }
        groupedData[record.timestamp].sum += record.value;
        groupedData[record.timestamp].count += 1;
      });

      return Object.values(groupedData).map(item => ({
        timestamp: item.timestamp,
        value: item.sum / item.count  // Average across all chains
      })).sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
      logger.error('[AvgGasPrice] Error fetching network history:', error);
      throw error;
    }
  }

  async getNetworkLatestAvgGasPrice() {
    try {
      // Get the most recent timestamp
      const latestRecord = await AvgGasPrice.findOne()
        .sort({ timestamp: -1 })
        .lean();

      if (!latestRecord) {
        return null;
      }

      const latestTimestamp = latestRecord.timestamp;

      // Get all records for that timestamp and calculate average
      const records = await AvgGasPrice.find({
        timestamp: latestTimestamp
      }).lean();

      const totalAvgGasPrice = records.reduce((sum, record) => sum + record.value, 0);
      const avgGasPrice = totalAvgGasPrice / records.length;

      return {
        timestamp: latestTimestamp,
        value: avgGasPrice,
        chainCount: records.length
      };
    } catch (error) {
      logger.error('[AvgGasPrice] Error fetching network latest:', error);
      throw error;
    }
  }
}

module.exports = new AvgGasPriceService();
