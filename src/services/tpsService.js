const TPS = require('../models/tps');
const CumulativeTxCount = require('../models/cumulativeTxCount');
const TxCount = require('../models/txCount');
const Chain = require('../models/chain');
const config = require('../config/config');
const logger = require('../utils/logger');
const createMetricService = require('./metricService');

// Cumulative transaction count is a plain day-bucketed metric, so it reuses the
// shared metric factory (fetch + rate-limit + retry + upsert) like every other
// metric service. TPS itself is NOT fetched from the API: it is derived below
// from the daily `txCount` that txCountService already stores, avoiding a second
// identical request to /metrics/txCount per chain.
const cumulativeTxCountService = createMetricService({
  model: CumulativeTxCount,
  metricPath: 'cumulativeTxCount',
  label: 'Cumulative TxCount',
  aggregation: 'sum'
});

// The in-progress (current UTC day) txCount bucket only covers the seconds
// elapsed so far. Dividing by a tiny window produces wildly inflated or (at
// exactly midnight) zero TPS, so the elapsed-seconds denominator is floored to
// this value. Past days always span a full 86400s window, so the floor never
// affects them — it only damps the in-progress day's first hour.
const MIN_ELAPSED_SECONDS = 60 * 60; // 1 hour
const FULL_DAY_SECONDS = 24 * 60 * 60;

class TpsService {
  /**
   * Derives decimal TPS from the daily txCount already fetched by txCountService
   * and stores it in the TPS collection. Makes no external API call.
   *
   * For a completed day TPS = txCount / 86400 (matching the metrics API's
   * integer avgTps but with decimal precision). For the in-progress day TPS =
   * txCountSoFar / secondsElapsedSoFar, but only once MIN_ELAPSED_SECONDS have
   * passed so the value isn't divided by a tiny (or zero) denominator.
   *
   * @param {string} chainId - The chain ID
   * @returns {Promise<Object>} - Result with { success, chainId, recordsProcessed }
   */
  async updateTpsData(chainId) {
    try {
      const currentTime = Math.floor(Date.now() / 1000);
      const thirtyDaysAgo = currentTime - (30 * 24 * 60 * 60);

      const txCountRecords = await TxCount.find({
        chainId: String(chainId),
        timestamp: { $gte: thirtyDaysAgo, $lte: currentTime }
      })
        .select('timestamp value')
        .lean();

      if (txCountRecords.length === 0) {
        logger.info(`[TPS Update] No txCount data to derive TPS from for chain ${chainId}`);
        return { success: true, chainId, recordsProcessed: 0, message: 'No txCount data available' };
      }

      const ops = [];
      for (const record of txCountRecords) {
        const timestamp = Number(record.timestamp);
        const value = parseFloat(record.value);

        if (isNaN(timestamp) || isNaN(value)) {
          continue;
        }

        // `timestamp` marks the start of the day-bucket. Past buckets cover a
        // full day (86400s); the in-progress bucket covers the seconds elapsed
        // so far. Skip non-positive windows (e.g. a future timestamp from clock
        // skew) and floor the denominator so the in-progress day's first hour
        // isn't divided by a tiny window (which would spike TPS).
        const elapsedSeconds = Math.min(FULL_DAY_SECONDS, currentTime - timestamp);
        if (elapsedSeconds <= 0) {
          continue;
        }

        const denominator = Math.max(elapsedSeconds, MIN_ELAPSED_SECONDS);
        const tps = parseFloat((value / denominator).toFixed(2));
        ops.push({
          updateOne: {
            filter: { chainId: String(chainId), timestamp },
            update: { $set: { value: tps, lastUpdated: new Date() } },
            upsert: true
          }
        });
      }

      if (ops.length === 0) {
        logger.info(`[TPS Update] No eligible txCount buckets to derive TPS for chain ${chainId}`);
        return { success: true, chainId, recordsProcessed: 0, message: 'No eligible data points' };
      }

      const result = await TPS.bulkWrite(ops, { ordered: false });

      logger.info(`[TPS Update] Derived TPS for chain ${chainId}:`, {
        recordsProcessed: ops.length,
        upserted: result.upsertedCount,
        modified: result.modifiedCount,
        environment: process.env.NODE_ENV
      });

      return {
        success: true,
        chainId,
        recordsProcessed: ops.length,
        upserted: result.upsertedCount,
        modified: result.modifiedCount
      };
    } catch (error) {
      logger.error(`[TPS Update] Error deriving TPS for chain ${chainId}:`, error.message);
      return { success: false, chainId, error: error.message };
    }
  }

  async getTpsHistory(chainId, days = 30) {
    try {
      const existingData = await TPS.countDocuments({ chainId });

      if (existingData === 0) {
        logger.info(`No TPS history found for chain ${chainId}, deriving from txCount...`);
        await this.updateTpsData(chainId);
      }

      const cutoffDate = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

      const data = await TPS.find({
        chainId,
        timestamp: { $gte: cutoffDate }
      })
        .sort({ timestamp: -1 })
        .select('-_id timestamp value')
        .lean();

      logger.info(`Found ${data.length} TPS records for chain ${chainId}`);
      return data;
    } catch (error) {
      logger.error(`Error fetching TPS history: ${error.message}`);
      throw new Error(`Error fetching TPS history: ${error.message}`);
    }
  }

  async getLatestTps(chainId) {
    try {
      let latest = await TPS.findOne({ chainId })
        .sort({ timestamp: -1 })
        .select('-_id timestamp value')
        .lean();

      // Don't fetch from API during chain list requests - let cron handle it
      if (!latest) {
        logger.debug(`No TPS data found for chain ${chainId}, will be fetched by cron job`);
        return null; // Return null instead of triggering slow API call
      }

      return latest;
    } catch (error) {
      logger.error(`Error fetching latest TPS: ${error.message}`);
      throw new Error(`Error fetching latest TPS: ${error.message}`);
    }
  }

  async getNetworkTps() {
    try {
      const chains = await Chain.find({ evmChainId: { $exists: true, $ne: null } }).select('evmChainId').lean();

      const currentTime = Math.floor(Date.now() / 1000);
      const oneDayAgo = currentTime - (24 * 60 * 60);

      // Add more detailed initial logging
      logger.info('Network TPS calculation - Time boundaries:', {
        currentTime: new Date(currentTime * 1000).toISOString(),
        oneDayAgo: new Date(oneDayAgo * 1000).toISOString(),
        currentTimestamp: currentTime,
        oneDayAgoTimestamp: oneDayAgo
      });

      // First get all TPS records for debugging
      const allTpsRecords = await TPS.find({
        timestamp: { $gte: oneDayAgo }
      }).lean();

      logger.info('All TPS records in last 24h:', {
        count: allTpsRecords.length,
        uniqueChains: [...new Set(allTpsRecords.map(r => r.chainId))].length,
        timeRange: {
          oldest: allTpsRecords.length ? new Date(Math.min(...allTpsRecords.map(r => r.timestamp * 1000))).toISOString() : null,
          newest: allTpsRecords.length ? new Date(Math.max(...allTpsRecords.map(r => r.timestamp * 1000))).toISOString() : null
        }
      });

      const latestTpsPromises = chains.map(chain =>
        TPS.findOne({
          chainId: String(chain.evmChainId),
          timestamp: { $gte: oneDayAgo, $lte: currentTime } // Add upper bound
        })
          .sort({ timestamp: -1 })
          .select('value timestamp chainId')
          .lean()
      );

      const tpsResults = await Promise.all(latestTpsPromises);
      const validResults = tpsResults.filter(result => {
        if (!result) return false;

        // Validate the timestamp is reasonable
        const timestamp = result.timestamp;
        const isValid = timestamp >= oneDayAgo && timestamp <= currentTime;

        if (!isValid) {
          logger.warn(`Invalid timestamp for chain ${result.chainId}:`, {
            timestamp: new Date(timestamp * 1000).toISOString(),
            value: result.value
          });
        }

        return isValid;
      });

      // Detailed logging of valid results
      logger.info('Network TPS calculation - Valid Results:', {
        totalChains: chains.length,
        validResults: validResults.length,
        chainDetails: validResults.map(r => ({
          chainId: r.chainId,
          tps: r.value,
          timestamp: new Date(r.timestamp * 1000).toISOString()
        })),
        environment: process.env.NODE_ENV
      });

      const timestamps = validResults.map(r => r.timestamp);
      const futureTimestamps = timestamps.filter(t => t > currentTime);
      if (futureTimestamps.length > 0) {
        logger.warn('Found future timestamps:', {
          count: futureTimestamps.length,
          timestamps: futureTimestamps.map(t => new Date(t * 1000).toISOString())
        });
      }

      logger.info('Network TPS calculation:', {
        totalChains: chains.length,
        validResults: validResults.length,
        oldestTimestamp: validResults.length ? new Date(Math.min(...timestamps) * 1000).toISOString() : null,
        newestTimestamp: validResults.length ? new Date(Math.max(...timestamps) * 1000).toISOString() : null,
        currentTime: new Date(currentTime * 1000).toISOString(),
        environment: process.env.NODE_ENV
      });

      if (validResults.length === 0) {
        return {
          totalTps: 0,
          chainCount: 0,
          timestamp: currentTime,
          updatedAt: new Date().toISOString(),
          dataAge: 0,
          dataAgeUnit: 'minutes'
        };
      }

      const total = validResults.reduce((sum, result) => sum + (result.value || 0), 0);
      const latestTimestamp = Math.max(...timestamps);
      const dataAge = Math.max(0, Math.floor((currentTime - latestTimestamp) / 60)); // Convert to minutes

      if (dataAge > 24 * 60) { // More than 24 hours in minutes
        logger.warn(`TPS data is ${dataAge} minutes old (${(dataAge/60).toFixed(1)} hours)`);
      }

      return {
        totalTps: parseFloat(total.toFixed(2)),
        chainCount: validResults.length,
        timestamp: latestTimestamp,
        updatedAt: new Date().toISOString(),
        dataAge,
        dataAgeUnit: 'minutes',
        lastUpdate: new Date(latestTimestamp * 1000).toISOString()
      };
    } catch (error) {
      logger.error('Error calculating network TPS:', error);
      throw error;
    }
  }

  async getNetworkTpsHistory(days = 7) {
    try {
      // Calculate cutoff from start of today to get complete days
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const cutoffDate = Math.floor(startOfToday.getTime() / 1000) - (days * 24 * 60 * 60);

      // Get all chains with evmChainId
      const chains = await Chain.find({ evmChainId: { $exists: true, $ne: null } }).select('evmChainId').lean();

      // Get TPS data for all chains within the time range
      const tpsData = await TPS.aggregate([
        {
          $match: {
            chainId: { $in: chains.map(c => String(c.evmChainId)) },
            timestamp: { $gte: cutoffDate }
          }
        },
        {
          // Group by timestamp and sum the values
          $group: {
            _id: '$timestamp',
            totalTps: { $sum: '$value' },
            chainCount: { $sum: 1 }
          }
        },
        {
          // Format the output
          $project: {
            _id: 0,
            timestamp: '$_id',
            totalTps: { $round: ['$totalTps', 2] },
            chainCount: 1
          }
        },
        {
          // Sort by timestamp
          $sort: { timestamp: 1 }
        }
      ]);

      // Add metadata to each data point
      const enrichedData = tpsData.map(point => ({
        ...point,
        date: new Date(point.timestamp * 1000).toISOString()
      }));

      logger.info(`Found ${enrichedData.length} historical network TPS records`);
      return enrichedData;
    } catch (error) {
      logger.error(`Error fetching network TPS history: ${error.message}`);
      throw new Error(`Error fetching network TPS history: ${error.message}`);
    }
  }

  /**
   * Updates cumulative transaction count data for a specific chain via the shared
   * metric factory.
   * @param {string} chainId - The chain ID
   * @param {number} retryCount - Number of retry attempts
   * @returns {Promise<Object>} - The result of the update operation
   */
  async updateCumulativeTxCount(chainId, retryCount = config.api.metrics.rateLimit.maxRetries || 3) {
    return cumulativeTxCountService.updateData(String(chainId), retryCount);
  }

  /**
   * Gets cumulative transaction count history for a specific chain
   * @param {string} chainId - The chain ID
   * @param {number} days - Number of days of history to fetch
   * @returns {Promise<Array>} - Array of transaction count data points
   */
  async getTxCountHistory(chainId, days = 30) {
    try {
      // Check cache first
      const cacheKey = `txcount_history_${chainId}_${days}`;
      const cacheManager = require('../utils/cacheManager');
      const cachedData = cacheManager.get(cacheKey);
      if (cachedData) {
        logger.debug('Returning cached TxCount history data');
        return cachedData;
      }

      const existingData = await CumulativeTxCount.countDocuments({ chainId });

      if (existingData === 0) {
        logger.info(`No TxCount history found for chain ${chainId}, fetching from API...`);
        await this.updateCumulativeTxCount(chainId, config.api.metrics.rateLimit.maxRetries);
      }

      const cutoffDate = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

      const data = await CumulativeTxCount.find({
        chainId,
        timestamp: { $gte: cutoffDate }
      })
        .sort({ timestamp: -1 })
        .select('-_id timestamp value')
        .lean();

      logger.info(`Found ${data.length} TxCount records for chain ${chainId}`);

      // Cache the result for 5 minutes
      cacheManager.set(cacheKey, data, config.cache.txCount);

      return data;
    } catch (error) {
      logger.error(`Error fetching TxCount history: ${error.message}`);
      throw new Error(`Error fetching TxCount history: ${error.message}`);
    }
  }

  /**
   * Gets the latest cumulative transaction count for a specific chain
   * @param {string} chainId - The chain ID
   * @returns {Promise<Object>} - The latest transaction count data
   */
  async getLatestTxCount(chainId) {
    try {
      // Check cache first
      const cacheKey = `txcount_latest_${chainId}`;
      const cacheManager = require('../utils/cacheManager');
      const cachedData = cacheManager.get(cacheKey);
      if (cachedData) {
        logger.debug('Returning cached latest TxCount data');
        return cachedData;
      }

      let latest = await CumulativeTxCount.findOne({ chainId })
        .sort({ timestamp: -1 })
        .select('-_id timestamp value')
        .lean();

      if (!latest) {
        logger.info(`No TxCount data found for chain ${chainId}, fetching from API...`);
        await this.updateCumulativeTxCount(chainId, config.api.metrics.rateLimit.maxRetries);
        latest = await CumulativeTxCount.findOne({ chainId })
          .sort({ timestamp: -1 })
          .select('-_id timestamp value')
          .lean();
      }

      // Cache the result for 5 minutes
      if (latest) {
        cacheManager.set(cacheKey, latest, config.cache.txCount);
      }

      return latest;
    } catch (error) {
      logger.error(`Error fetching latest TxCount: ${error.message}`);
      throw new Error(`Error fetching latest TxCount: ${error.message}`);
    }
  }
}

module.exports = new TpsService();
