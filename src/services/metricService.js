const axios = require('axios');
const Chain = require('../models/chain');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Generic per-chain time-series metric service.
 *
 * The Metrics API exposes several day-bucketed metrics (activeAddresses,
 * txCount, gasUsed, avgGasPrice, maxTps, feesPaid) that are fetched, stored,
 * and queried identically. This factory captures that shared behavior so each
 * concrete service is just a thin configuration wrapper.
 *
 * @param {Object}  options
 * @param {import('mongoose').Model} options.model    Mongoose model storing { chainId, timestamp, value, lastUpdated }.
 * @param {string}  options.metricPath                Metrics API path segment, e.g. 'activeAddresses'.
 * @param {string}  options.label                     Human label used in log lines, e.g. 'Active Addresses'.
 * @param {'sum'|'avg'} [options.aggregation='sum']   How to combine per-chain values into a network value.
 */
function createMetricService({ model, metricPath, label, aggregation = 'sum' }) {
  if (!model) throw new Error('createMetricService: model is required');
  if (!metricPath) throw new Error('createMetricService: metricPath is required');
  if (!label) throw new Error('createMetricService: label is required');

  // Rate limiter implementation (one instance per metric service, matching the
  // original per-service behavior: each metric gets its own request budget).
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

          logger.info(`Rate limit reached, waiting ${Math.round(timeToWait / 1000)}s before next request`);

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

  async function updateData(chainId, retryCount = config.api.metrics.rateLimit.maxRetries || 3) {
    return metricsApiRateLimiter.enqueue(async () => {
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          logger.info(`[${label} Update] Starting update for chain ${chainId} (Attempt ${attempt}/${retryCount})`);

          const headers = {
            'Accept': 'application/json',
            'User-Agent': 'l1beat-backend',
            'Cache-Control': 'no-cache'
          };

          if (process.env.GLACIER_API_KEY) {
            headers['x-api-key'] = process.env.GLACIER_API_KEY;
          }

          const response = await axios.get(`${config.api.metrics.baseUrl}/chains/${chainId}/metrics/${metricPath}`, {
            params: {
              timeInterval: 'day',
              pageSize: 100  // Maximum allowed by API
            },
            timeout: config.api.metrics.timeout,
            headers
          });

          if (!response.data || !Array.isArray(response.data.results)) {
            logger.warn(`[${label} Update] Invalid response format for chain ${chainId}`);
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
            const result = await model.bulkWrite(
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

            logger.info(`[${label} Update] Updated chain ${chainId}:`, {
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

          logger.info(`[${label} Update] No valid data for chain ${chainId}`);
          return {
            success: true,
            chainId,
            recordsProcessed: 0,
            message: 'No valid data points'
          };

        } catch (error) {
          logger.error(`[${label} Update] Error for chain ${chainId} (Attempt ${attempt}/${retryCount}):`, error.message);

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

  async function updateAllChains() {
    try {
      logger.info(`[${label}] Starting update for all chains`);

      const chains = await Chain.find({});
      const results = [];

      for (const chain of chains) {
        const chainId = chain.evmChainId || chain.chainId;

        if (!chainId || !/^\d+$/.test(String(chainId))) {
          logger.warn(`[${label}] Skipping chain with invalid ID:`, chain.name);
          continue;
        }

        const result = await updateData(String(chainId));
        results.push(result);
      }

      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      logger.info(`[${label}] Update completed:`, {
        total: chains.length,
        successful,
        failed
      });

      return { success: true, results };
    } catch (error) {
      logger.error(`[${label}] Error updating all chains:`, error);
      return { success: false, error: error.message };
    }
  }

  async function getHistory(chainId, days = 30) {
    try {
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = endTime - (days * 24 * 60 * 60);

      const data = await model.find({
        chainId: String(chainId),
        timestamp: { $gte: startTime, $lte: endTime }
      })
        .sort({ timestamp: 1 })
        .lean();

      return data;
    } catch (error) {
      logger.error(`[${label}] Error fetching history for chain ${chainId}:`, error);
      throw error;
    }
  }

  async function getLatest(chainId) {
    try {
      const latestRecord = await model.findOne({
        chainId: String(chainId)
      })
        .sort({ timestamp: -1 })
        .lean();

      return latestRecord;
    } catch (error) {
      logger.error(`[${label}] Error fetching latest for chain ${chainId}:`, error);
      throw error;
    }
  }

  async function getNetworkHistory(days = 30) {
    try {
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = endTime - (days * 24 * 60 * 60);

      const data = await model.find({
        timestamp: { $gte: startTime, $lte: endTime }
      })
        .sort({ timestamp: 1 })
        .lean();

      if (aggregation === 'avg') {
        // Group by timestamp and calculate the average across all chains.
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
      }

      // Group by timestamp and sum across all chains.
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
      logger.error(`[${label}] Error fetching network history:`, error);
      throw error;
    }
  }

  async function getNetworkLatest() {
    try {
      // Get the most recent timestamp
      const latestRecord = await model.findOne()
        .sort({ timestamp: -1 })
        .lean();

      if (!latestRecord) {
        return null;
      }

      const latestTimestamp = latestRecord.timestamp;

      // Get all records for that timestamp and combine them
      const records = await model.find({
        timestamp: latestTimestamp
      }).lean();

      const total = records.reduce((sum, record) => sum + record.value, 0);
      const value = aggregation === 'avg'
        ? (records.length ? total / records.length : 0)  // Average across all chains
        : total;                                          // Sum across all chains

      return {
        timestamp: latestTimestamp,
        value,
        chainCount: records.length
      };
    } catch (error) {
      logger.error(`[${label}] Error fetching network latest:`, error);
      throw error;
    }
  }

  return {
    updateData,
    updateAllChains,
    getHistory,
    getLatest,
    getNetworkHistory,
    getNetworkLatest
  };
}

module.exports = createMetricService;
