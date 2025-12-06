const TPS = require('../models/tps');
const CumulativeTxCount = require('../models/cumulativeTxCount');
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

  // Add a request to the queue
  async enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  // Process the queue
  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    try {
      // Check if we've exceeded rate limit
      const now = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(
        timestamp => now - timestamp < 60000 // Keep only timestamps from the last minute
      );
      
      if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
        // We've hit the rate limit, wait until we can make another request
        const oldestTimestamp = this.requestTimestamps[0];
        const timeToWait = 60000 - (now - oldestTimestamp);
        
        logger.info(`Rate limit reached, waiting ${Math.round(timeToWait/1000)}s before next request`);
        
        setTimeout(() => {
          this.processing = false;
          this.processQueue();
        }, timeToWait + 100); // Add a small buffer
        
        return;
      }
      
      // Process the next item in the queue
      const item = this.queue.shift();
      this.requestTimestamps.push(now);
      
      try {
        const result = await item.fn();
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }
      
      // Small delay between requests
      setTimeout(() => {
        this.processing = false;
        this.processQueue();
      }, 300); // 300ms between requests
    } catch (error) {
      logger.error('Error in rate limiter:', error);
      this.processing = false;
    }
  }
}

// Create a global rate limiter instance
const metricsApiRateLimiter = new RateLimiter(config.api.metrics.rateLimit.requestsPerMinute || 20);

class TpsService {
  async updateTpsData(chainId, retryCount = config.api.metrics.rateLimit.maxRetries || 3, initialBackoffMs = config.api.metrics.rateLimit.retryDelay || 2000) {
    // Use rate limiter for all API calls
    return metricsApiRateLimiter.enqueue(async () => {
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          logger.info(`[TPS Update] Starting update for chain ${chainId} (Attempt ${attempt}/${retryCount})`);
          
          // Use the new metrics API endpoint
          const headers = {
            'Accept': 'application/json',
            'User-Agent': 'l1beat-backend',
            'Cache-Control': 'no-cache' // Avoid cached responses
          };

          // Add API key if available
          if (process.env.GLACIER_API_KEY) {
            headers['x-api-key'] = process.env.GLACIER_API_KEY;
          }

          const response = await axios.get(`${config.api.metrics.baseUrl}/chains/${chainId}/metrics/avgTps`, {
            params: {
              timeInterval: 'day',
              pageSize: 100  // Maximum allowed by API
            },
            timeout: config.api.metrics.timeout,
            headers
          });

          // Enhanced error logging
          if (!response.data) {
            logger.warn(`[TPS Update] No data in response for chain ${chainId}`);
            continue;
          }

          if (!Array.isArray(response.data.results)) {
            logger.warn(`[TPS Update] Invalid response format for chain ${chainId}:`, response.data);
            continue;
          }

          const currentTime = Math.floor(Date.now() / 1000);
          const thirtyDaysAgo = currentTime - (30 * 24 * 60 * 60);

          // Log raw data before filtering
          logger.info(`[TPS Update] Raw data for chain ${chainId}:`, {
            resultsCount: response.data.results.length,
            sampleData: response.data.results[0],
            environment: process.env.NODE_ENV
          });

          // Validate and filter TPS data
          const validTpsData = response.data.results.filter(item => {
            const timestamp = Number(item.timestamp);
            const value = parseFloat(item.value);
            
            if (isNaN(timestamp) || isNaN(value)) {
              logger.warn(`[TPS Update] Invalid data point for chain ${chainId}:`, item);
              return false;
            }
            
            const isValid = timestamp >= thirtyDaysAgo && timestamp <= currentTime;
            if (!isValid) {
              logger.debug(`[TPS Update] Out of range timestamp for chain ${chainId}:`, {
                timestamp: new Date(timestamp * 1000).toISOString(),
                value
              });
            }
            
            return isValid;
          });

          // If we have valid data, proceed with update
          if (validTpsData.length > 0) {
            const result = await TPS.bulkWrite(
              validTpsData.map(item => ({
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
              { ordered: false } // Continue processing even if some operations fail
            );

            logger.info(`[TPS Update] Success for chain ${chainId}:`, {
              validDataPoints: validTpsData.length,
              matched: result.matchedCount,
              modified: result.modifiedCount,
              upserted: result.upsertedCount,
              environment: process.env.NODE_ENV
            });

            return result;
          }

          logger.warn(`[TPS Update] No valid data points for chain ${chainId}`);
          return null;

        } catch (error) {
          const status = error.response?.status;
          logger.error(`[TPS Update] Error for chain ${chainId} (Attempt ${attempt}/${retryCount}):`, {
            message: error.message,
            status: status,
            data: error.response?.data,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
          });

          // Special handling for rate limiting
          if (status === 429) {
            logger.warn(`[TPS Update] Rate limit exceeded for metrics API, backing off...`);
            
            if (attempt < retryCount) {
              // Exponential backoff with jitter for rate limit errors
              const backoffTime = initialBackoffMs * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
              logger.info(`[TPS Update] Will retry after ${Math.round(backoffTime/1000)}s`);
              await new Promise(resolve => setTimeout(resolve, backoffTime));
            }
          } else if (attempt < retryCount) {
            // Normal retry for other errors, with shorter backoff
            const backoffTime = initialBackoffMs * (attempt - 1) * (0.75 + Math.random() * 0.5);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
          }

          if (attempt === retryCount) {
            // On final attempt, log but don't throw
            logger.error(`[TPS Update] All attempts failed for chain ${chainId}`);
            return null;
          }
        }
      }
      return null;
    });
  }

  async getTpsHistory(chainId, days = 30) {
    try {
      const existingData = await TPS.countDocuments({ chainId });
      
      if (existingData === 0) {
        logger.info(`No TPS history found for chain ${chainId}, fetching from API...`);
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
   * Updates cumulative transaction count data for a specific chain
   * @param {string} chainId - The chain ID
   * @param {number} retryCount - Number of retry attempts
   * @param {number} initialBackoffMs - Initial backoff time in milliseconds
   * @returns {Promise<Object|null>} - The result of the update operation or null on failure
   */
  async updateCumulativeTxCount(chainId, retryCount = config.api.metrics.rateLimit.maxRetries || 3, initialBackoffMs = config.api.metrics.rateLimit.retryDelay || 2000) {
    // Use rate limiter for all API calls
    return metricsApiRateLimiter.enqueue(async () => {
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          logger.info(`[TxCount Update] Starting update for chain ${chainId} (Attempt ${attempt}/${retryCount})`);
          
          // Use the metrics API endpoint with cumulativeTxCount metric (daily interval)
          const response = await axios.get(`${config.api.metrics.baseUrl}/chains/${chainId}/metrics/cumulativeTxCount`, {
            params: {
              timeInterval: 'day',
              pageSize: 100  // Maximum allowed by API
            },
            timeout: config.api.metrics.timeout,
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'l1beat-backend',
              'Cache-Control': 'no-cache' // Avoid cached responses
            }
          });

          // Enhanced error logging
          if (!response.data) {
            logger.warn(`[TxCount Update] No data in response for chain ${chainId}`);
            continue;
          }

          if (!Array.isArray(response.data.results)) {
            logger.warn(`[TxCount Update] Invalid response format for chain ${chainId}:`, response.data);
            continue;
          }

          const currentTime = Math.floor(Date.now() / 1000);
          const thirtyDaysAgo = currentTime - (30 * 24 * 60 * 60);

          // Log raw data before filtering
          logger.info(`[TxCount Update] Raw data for chain ${chainId}:`, {
            resultsCount: response.data.results.length,
            sampleData: response.data.results[0],
            environment: process.env.NODE_ENV
          });

          // Validate and filter TxCount data
          const validTxCountData = response.data.results.filter(item => {
            const timestamp = Number(item.timestamp);
            const value = parseFloat(item.value);
            
            if (isNaN(timestamp) || isNaN(value)) {
              logger.warn(`[TxCount Update] Invalid data point for chain ${chainId}:`, item);
              return false;
            }
            
            const isValid = timestamp >= thirtyDaysAgo && timestamp <= currentTime;
            if (!isValid) {
              logger.debug(`[TxCount Update] Out of range timestamp for chain ${chainId}:`, {
                timestamp: new Date(timestamp * 1000).toISOString(),
                value
              });
            }
            
            return isValid;
          });

          // If we have valid data, proceed with update
          if (validTxCountData.length > 0) {
            const result = await CumulativeTxCount.bulkWrite(
              validTxCountData.map(item => ({
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
              { ordered: false } // Continue processing even if some operations fail
            );

            logger.info(`[TxCount Update] Success for chain ${chainId}:`, {
              validDataPoints: validTxCountData.length,
              matched: result.matchedCount,
              modified: result.modifiedCount,
              upserted: result.upsertedCount,
              environment: process.env.NODE_ENV
            });

            return result;
          }

          logger.warn(`[TxCount Update] No valid data points for chain ${chainId}`);
          return null;

        } catch (error) {
          const status = error.response?.status;
          logger.error(`[TxCount Update] Error for chain ${chainId} (Attempt ${attempt}/${retryCount}):`, {
            message: error.message,
            status: status,
            data: error.response?.data,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
          });

          // Special handling for rate limiting
          if (status === 429) {
            logger.warn(`[TxCount Update] Rate limit exceeded for metrics API, backing off...`);
            
            if (attempt < retryCount) {
              // Exponential backoff with jitter for rate limit errors
              const backoffTime = initialBackoffMs * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
              logger.info(`[TxCount Update] Will retry after ${Math.round(backoffTime/1000)}s`);
              await new Promise(resolve => setTimeout(resolve, backoffTime));
            }
          } else if (attempt < retryCount) {
            // Normal retry for other errors, with shorter backoff
            const backoffTime = initialBackoffMs * (attempt - 1) * (0.75 + Math.random() * 0.5);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
          }

          if (attempt === retryCount) {
            // On final attempt, log but don't throw
            logger.error(`[TxCount Update] All attempts failed for chain ${chainId}`);
            return null;
          }
        }
      }
      return null;
    });
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
        await this.updateCumulativeTxCount(chainId, config.api.metrics.rateLimit.maxRetries, config.api.metrics.rateLimit.retryDelay);
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
        await this.updateCumulativeTxCount(chainId, config.api.metrics.rateLimit.maxRetries, config.api.metrics.rateLimit.retryDelay);
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