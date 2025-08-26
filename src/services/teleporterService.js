const axios = require('axios');
const config = require('../config/config');
const logger = require('../utils/logger');
const { TeleporterMessage, TeleporterUpdateState } = require('../models/teleporterMessage');

class TeleporterService {
    constructor() {
        this.GLACIER_API_BASE = process.env.GLACIER_API_BASE || config.api.glacier.baseUrl;
        this.GLACIER_API_KEY = process.env.GLACIER_API_KEY;
        this.UPDATE_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
        this.TIMEOUT = 30000; // 30 seconds
        
        if (!this.GLACIER_API_KEY) {
            logger.warn('GLACIER_API_KEY not found in environment variables');
        }
        
        if (!this.GLACIER_API_BASE) {
            logger.error('GLACIER_API_BASE not configured');
        }
        
        logger.info('TeleporterService initialized', {
            hasApiKey: !!this.GLACIER_API_KEY,
            apiBase: this.GLACIER_API_BASE
        });
    }

    /**
     * Fetch ICM messages from Glacier API
     * @param {number} hoursAgo - How many hours ago to start fetching from
     * @returns {Promise<Array>} Array of messages
     */
    async fetchICMMessages(hoursAgo = 24) {
        try {
            const endTime = Math.floor(Date.now() / 1000);
            const startTime = endTime - (hoursAgo * 60 * 60);

            const headers = {
                'Accept': 'application/json',
                'User-Agent': 'l1beat-backend'
            };

            if (this.GLACIER_API_KEY) {
                headers['x-glacier-api-key'] = this.GLACIER_API_KEY;
            }

            const params = {
                startTime,
                endTime,
                network: 'mainnet',
                pageSize: 100
            };

            logger.info(`Fetching ICM messages from ${hoursAgo} hours ago`, { 
                startTime, 
                endTime,
                startTimeISO: new Date(startTime * 1000).toISOString(),
                endTimeISO: new Date(endTime * 1000).toISOString()
            });

            let allMessages = [];
            let nextPageToken = null;
            let pageCount = 0;
            const maxPages = 1000; // Higher safety limit
            let reachedTimeLimit = false;

            do {
                pageCount++;
                
                if (nextPageToken) {
                    params.pageToken = nextPageToken;
                }

                const response = await axios.get(`${this.GLACIER_API_BASE}/icm/messages`, {
                    headers,
                    params,
                    timeout: this.TIMEOUT
                });

                const messages = response.data?.messages || [];
                let validMessages = [];

                // Check each message timestamp to see if it's within our time window
                for (const message of messages) {
                    let messageTimestamp = null;

                    // Try to get timestamp from sourceTransaction first, then fallback to message timestamp
                    if (message.sourceTransaction && message.sourceTransaction.timestamp) {
                        messageTimestamp = message.sourceTransaction.timestamp;
                    } else if (message.timestamp) {
                        messageTimestamp = message.timestamp;
                    }

                    if (!messageTimestamp) {
                        // If no timestamp found, include the message (we can't determine its age)
                        validMessages.push(message);
                        continue;
                    }

                    // Convert timestamp to seconds if it's in milliseconds
                    const timestampInSeconds = messageTimestamp > 1000000000000 
                        ? Math.floor(messageTimestamp / 1000) 
                        : messageTimestamp;

                    // Check if the message is within our time range
                    if (timestampInSeconds >= startTime) {
                        validMessages.push(message);
                    } else {
                        // Found a message older than our time window, stop pagination
                        reachedTimeLimit = true;
                        logger.info(`Found message older than ${hoursAgo} hours, stopping pagination`, {
                            messageTimestamp: new Date(timestampInSeconds * 1000).toISOString(),
                            startTime: new Date(startTime * 1000).toISOString(),
                            page: pageCount,
                            messageId: message.messageId || 'unknown'
                        });
                        break;
                    }
                }

                // Add valid messages from this page to our collection
                allMessages = allMessages.concat(validMessages);
                nextPageToken = response.data?.nextPageToken;

                logger.info(`Fetched page ${pageCount}, got ${messages.length} messages (${validMessages.length} valid)`, {
                    totalMessages: allMessages.length,
                    hasNextPage: !!nextPageToken,
                    reachedTimeLimit
                });

                // If we reached the time limit, stop pagination
                if (reachedTimeLimit) {
                    logger.info(`Reached time limit (${hoursAgo} hours), stopping pagination`);
                    break;
                }

                // Safety check to prevent infinite loops (should rarely be hit now)
                if (pageCount >= maxPages) {
                    logger.warn(`Reached maximum page limit (${maxPages}), stopping pagination`);
                    break;
                }

                // Small delay between requests to be respectful to the API
                if (nextPageToken) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

            } while (nextPageToken);

            logger.info(`Completed fetching ICM messages: ${allMessages.length} total messages from ${pageCount} pages`, {
                reachedTimeLimit,
                hitPageLimit: pageCount >= maxPages
            });
            return allMessages;

        } catch (error) {
            logger.error('Error fetching ICM messages:', {
                message: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText
            });
            throw error;
        }
    }

    /**
     * Fetch chain data and create chainId to chainName mapping
     * @returns {Promise<Object>} Mapping of chainId to chainName
     */
    async getChainMapping() {
        try {
            // Check if we have cached mapping (cache for 1 hour)
            if (this.chainMapping && this.chainMappingLastUpdate && 
                (Date.now() - this.chainMappingLastUpdate) < (60 * 60 * 1000)) {
                return this.chainMapping;
            }

            logger.info('Fetching chain data for name mapping...');
            
            // Fetch chain data from our own API
            const response = await axios.get(`http://localhost:${process.env.PORT || 5001}/api/chains`, {
                timeout: this.TIMEOUT,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'l1beat-backend-internal'
                }
            });

            const chains = response.data || [];
            const mapping = {};

            for (const chain of chains) {
                if (chain.chainId && chain.chainName) {
                    mapping[chain.chainId] = chain.chainName;
                }
            }

            // Cache the mapping
            this.chainMapping = mapping;
            this.chainMappingLastUpdate = Date.now();

            logger.info(`Created chain mapping for ${Object.keys(mapping).length} chains`);
            return mapping;

        } catch (error) {
            logger.error('Error fetching chain mapping:', error);
            // Return empty mapping as fallback
            return this.chainMapping || {};
        }
    }

    /**
     * Process messages to count by chain pairs
     * @param {Array} messages - Array of ICM messages
     * @returns {Array} Processed message counts
     */
    async processMessages(messages) {
        const counts = {};

        logger.info(`Processing ${messages.length} ICM messages`);

        // Get chain mapping
        const chainMapping = await this.getChainMapping();

        for (const message of messages) {
            if (!message.sourceEvmChainId || !message.destinationEvmChainId) {
                continue; // Skip messages without chain IDs
            }

            // Use chain names if available, fallback to "Chain {id}" format
            const sourceChain = chainMapping[message.sourceEvmChainId] || `Chain ${message.sourceEvmChainId}`;
            const destinationChain = chainMapping[message.destinationEvmChainId] || `Chain ${message.destinationEvmChainId}`;
            const key = `${sourceChain}|${destinationChain}`;

            if (!counts[key]) {
                counts[key] = {
                    sourceChain,
                    destinationChain,
                    messageCount: 0
                };
            }
            counts[key].messageCount++;
        }

        const result = Object.values(counts).sort((a, b) => b.messageCount - a.messageCount);
        
        logger.info(`Processed messages into ${result.length} chain pairs with actual chain names`);
        return result;
    }

    /**
     * Update daily teleporter data
     */
    async updateDailyData() {
        try {
            logger.info('[TELEPORTER DAILY] Starting daily teleporter data update (last 24 hours)');

            // Check if update is already in progress
            const existingUpdate = await TeleporterUpdateState.findOne({
                updateType: 'daily',
                state: 'in_progress'
            });

            if (existingUpdate) {
                const timeSinceUpdate = Date.now() - new Date(existingUpdate.lastUpdatedAt).getTime();
                if (timeSinceUpdate < 10 * 60 * 1000) { // 10 minutes
                    logger.info('[TELEPORTER DAILY] Update already in progress, skipping');
                    return { success: true, status: 'in_progress' };
                }

                // Mark stale update as failed
                existingUpdate.state = 'failed';
                existingUpdate.error = { message: 'Update timed out' };
                await existingUpdate.save();
                logger.warn('[TELEPORTER DAILY] Marked stale update as failed, proceeding with new update');
            }

            // Create new update state
            const updateState = new TeleporterUpdateState({
                updateType: 'daily',
                state: 'in_progress',
                startedAt: new Date(),
                lastUpdatedAt: new Date()
            });
            await updateState.save();

            logger.info('[TELEPORTER DAILY] Fetching ICM messages for last 24 hours...');
            // Fetch and process messages
            const messages = await this.fetchICMMessages(24);
            logger.info(`[TELEPORTER DAILY] Fetched ${messages.length} raw messages from Glacier API`);
            
            const processedData = await this.processMessages(messages);
            logger.info(`[TELEPORTER DAILY] Processed into ${processedData.length} unique chain pairs`);

            // Clean up old daily data (older than 90 days) to prevent database bloat
            const ninetyDaysAgo = new Date();
            ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
            
            const deletedCount = await TeleporterMessage.deleteMany({ 
                dataType: 'daily',
                updatedAt: { $lt: ninetyDaysAgo }
            });
            
            if (deletedCount.deletedCount > 0) {
                logger.info(`[TELEPORTER DAILY] Cleaned up ${deletedCount.deletedCount} old daily records (>90 days)`);
            }

            // Check if we already have data for today (to avoid duplicates)
            const today = new Date();
            const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
            
            const existingTodayData = await TeleporterMessage.findOne({
                dataType: 'daily',
                updatedAt: { $gte: todayStart, $lt: todayEnd }
            });

            if (existingTodayData) {
                // Update existing data for today
                existingTodayData.updatedAt = new Date();
                existingTodayData.messageCounts = processedData;
                existingTodayData.totalMessages = messages.length;
                existingTodayData.timeWindow = 24;
                await existingTodayData.save();
                logger.info(`[TELEPORTER DAILY] Updated existing daily snapshot for today`);
            } else {
                // Create new daily snapshot
                const teleporterData = new TeleporterMessage({
                    updatedAt: new Date(),
                    messageCounts: processedData,
                    totalMessages: messages.length,
                    timeWindow: 24,
                    dataType: 'daily'
                });
                await teleporterData.save();
                logger.info(`[TELEPORTER DAILY] Created new daily snapshot`);
            }

            // Update state to completed
            updateState.state = 'completed';
            updateState.lastUpdatedAt = new Date();
            await updateState.save();

            logger.info(`[TELEPORTER DAILY] ✅ Successfully completed daily update: ${messages.length} messages, ${processedData.length} chain pairs`);

            return {
                success: true,
                messageCount: processedData.length,
                totalMessages: messages.length
            };

        } catch (error) {
            logger.error('[TELEPORTER DAILY] ❌ Error updating daily data:', error);

            // Update state to failed
            const updateState = await TeleporterUpdateState.findOne({ updateType: 'daily' });
            if (updateState) {
                updateState.state = 'failed';
                updateState.error = { message: error.message };
                updateState.lastUpdatedAt = new Date();
                await updateState.save();
            }

            throw error;
        }
    }

    /**
     * Update weekly teleporter data (last 7 days)
     */
    async updateWeeklyData() {
        try {
            logger.info('[TELEPORTER WEEKLY] Starting weekly teleporter data update (last 7 days)');

            // Check if update is already in progress
            const existingUpdate = await TeleporterUpdateState.findOne({
                updateType: 'weekly',
                state: 'in_progress'
            });

            if (existingUpdate) {
                const timeSinceUpdate = Date.now() - new Date(existingUpdate.lastUpdatedAt).getTime();
                if (timeSinceUpdate < 30 * 60 * 1000) { // 30 minutes for weekly
                    logger.info('[TELEPORTER WEEKLY] Weekly update already in progress, skipping');
                    return { success: true, status: 'in_progress' };
                }

                // Mark stale update as failed
                existingUpdate.state = 'failed';
                existingUpdate.error = { message: 'Update timed out' };
                await existingUpdate.save();
                logger.warn('[TELEPORTER WEEKLY] Marked stale update as failed, proceeding with new update');
            }

            // Create new update state
            const updateState = new TeleporterUpdateState({
                updateType: 'weekly',
                state: 'in_progress',
                startedAt: new Date(),
                lastUpdatedAt: new Date()
            });
            await updateState.save();

            // Fetch and process messages for the last 7 days (168 hours)
            logger.info('[TELEPORTER WEEKLY] Fetching ICM messages for last 7 days (168 hours)...');
            const messages = await this.fetchICMMessages(168); // 7 * 24 = 168 hours
            logger.info(`[TELEPORTER WEEKLY] Fetched ${messages.length} raw messages from Glacier API`);
            
            const processedData = await this.processMessages(messages);
            logger.info(`[TELEPORTER WEEKLY] Processed into ${processedData.length} unique chain pairs`);

            // Save to database (replace existing weekly data)
            await TeleporterMessage.deleteMany({ dataType: 'weekly' });
            
            const teleporterData = new TeleporterMessage({
                updatedAt: new Date(),
                messageCounts: processedData,
                totalMessages: messages.length,
                timeWindow: 168,
                dataType: 'weekly'
            });
            await teleporterData.save();

            // Update state to completed
            updateState.state = 'completed';
            updateState.lastUpdatedAt = new Date();
            await updateState.save();

            logger.info(`[TELEPORTER WEEKLY] ✅ Successfully completed weekly update: ${messages.length} messages, ${processedData.length} chain pairs`);

            return {
                success: true,
                messageCount: processedData.length,
                totalMessages: messages.length
            };

        } catch (error) {
            logger.error('[TELEPORTER WEEKLY] ❌ Error updating weekly data:', error);

            // Update state to failed
            const updateState = await TeleporterUpdateState.findOne({ updateType: 'weekly' });
            if (updateState) {
                updateState.state = 'failed';
                updateState.error = { message: error.message };
                updateState.lastUpdatedAt = new Date();
                await updateState.save();
            }

            throw error;
        }
    }

    /**
     * Get daily message counts
     * @returns {Promise<Object>} Daily message count data
     */
    async getDailyMessageCounts() {
        try {
            // Get from database first
            const data = await TeleporterMessage.findOne({ dataType: 'daily' })
                .sort({ updatedAt: -1 });

            if (data) {
                const age = Date.now() - new Date(data.updatedAt).getTime();
                
                // If data is older than 1 hour, trigger background update
                if (age > this.UPDATE_INTERVAL) {
                    logger.info('[TELEPORTER DAILY] Data is older than 1 hour, triggering background update');
                    this.updateDailyData().catch(err => {
                        logger.error('[TELEPORTER DAILY] Background update failed:', err);
                    });
                }

                return {
                    data: data.messageCounts.map(item => ({
                        sourceChain: item.sourceChain,
                        destinationChain: item.destinationChain,
                        messageCount: item.messageCount
                    })),
                    metadata: {
                        totalMessages: data.totalMessages,
                        timeWindow: data.timeWindow,
                        timeWindowUnit: 'hours',
                        updatedAt: data.updatedAt
                    }
                };
            }

            // If no data exists, trigger update and return empty result
            logger.info('[TELEPORTER DAILY] No daily data found, triggering initial update');
            this.updateDailyData().catch(err => {
                logger.error('[TELEPORTER DAILY] Initial update failed:', err);
            });

            return {
                data: [],
                metadata: {
                    totalMessages: 0,
                    timeWindow: 24,
                    timeWindowUnit: 'hours',
                    updatedAt: new Date()
                }
            };

        } catch (error) {
            logger.error('Error getting daily message counts:', error);
            throw error;
        }
    }

    /**
     * Get weekly message counts (last 7 days)
     * @returns {Promise<Object>} Weekly message count data
     */
    async getWeeklyMessageCounts() {
        try {
            // Get from database first
            const data = await TeleporterMessage.findOne({ dataType: 'weekly' })
                .sort({ updatedAt: -1 });

            if (data) {
                const age = Date.now() - new Date(data.updatedAt).getTime();
                
                // If data is older than 6 hours, trigger background update (weekly data doesn't need to be as fresh)
                if (age > 6 * 60 * 60 * 1000) {
                    logger.info('[TELEPORTER WEEKLY] Weekly data is older than 6 hours, triggering background update');
                    this.updateWeeklyData().catch(err => {
                        logger.error('[TELEPORTER WEEKLY] Background weekly update failed:', err);
                    });
                }

                return {
                    data: data.messageCounts.map(item => ({
                        sourceChain: item.sourceChain,
                        destinationChain: item.destinationChain,
                        messageCount: item.messageCount
                    })),
                    metadata: {
                        totalMessages: data.totalMessages,
                        timeWindow: data.timeWindow,
                        timeWindowUnit: 'hours',
                        updatedAt: data.updatedAt
                    }
                };
            }

            // If no data exists, trigger update and return empty result
            logger.info('[TELEPORTER WEEKLY] No weekly data found, triggering initial update');
            this.updateWeeklyData().catch(err => {
                logger.error('[TELEPORTER WEEKLY] Initial weekly update failed:', err);
            });

            return {
                data: [],
                metadata: {
                    totalMessages: 0,
                    timeWindow: 168,
                    timeWindowUnit: 'hours',
                    updatedAt: new Date()
                }
            };

        } catch (error) {
            logger.error('Error getting weekly message counts:', error);
            throw error;
        }
    }

    /**
     * Legacy method to maintain compatibility with existing controller
     * @param {string} requestId - Optional request ID for tracking
     * @returns {Promise<Array>} Array of message counts
     */
    async getDailyCrossChainMessageCount(requestId = 'unknown') {
        try {
            const result = await this.getDailyMessageCounts();
            return result.data;
        } catch (error) {
            logger.error('Error in legacy getDailyCrossChainMessageCount:', error);
            return [];
        }
    }

    /**
     * Legacy method to maintain compatibility with existing controller
     * @returns {Promise<Array>} Array of weekly message counts
     */
    async getWeeklyCrossChainMessageCount() {
        try {
            const result = await this.getWeeklyMessageCounts();
            return result.data;
        } catch (error) {
            logger.error('Error in legacy getWeeklyCrossChainMessageCount:', error);
            return [];
        }
    }

    /**
     * Legacy method to maintain compatibility
     * @returns {Promise<Object|null>} Message count data or null
     */
    async getAnyMessageCountFromDB(dataType = 'daily') {
        try {
            const data = await TeleporterMessage.findOne({ dataType })
                .sort({ updatedAt: -1 });
            return data;
        } catch (error) {
            logger.error('Error getting message count from database:', error);
            return null;
        }
    }

    /**
     * Start periodic updates
     */
    startPeriodicUpdates() {
        // Initial updates
        this.updateDailyData().catch(err => {
            logger.error('Initial daily update failed:', err);
        });

        this.updateWeeklyData().catch(err => {
            logger.error('Initial weekly update failed:', err);
        });

        // Set up hourly updates for daily data
        setInterval(() => {
            this.updateDailyData().catch(err => {
                logger.error('Periodic daily update failed:', err);
            });
        }, this.UPDATE_INTERVAL);

        // Set up daily updates for weekly data (every 24 hours)
        setInterval(() => {
            this.updateWeeklyData().catch(err => {
                logger.error('Periodic weekly update failed:', err);
            });
        }, 24 * 60 * 60 * 1000); // 24 hours

        logger.info('Started periodic updates (daily: every hour, weekly: every 24 hours)');
    }

    /**
     * Legacy method for backward compatibility with existing cron jobs
     * @param {string} requestId - Optional request ID for tracking
     * @returns {Promise<Object>} Update result
     */
    async updateTeleporterData(requestId = 'unknown') {
        return await this.updateDailyData();
    }

    /**
     * Get historical daily cross-chain message counts for the past N days
     * @param {number} days - Number of days to retrieve (default: 30)
     * @returns {Promise<Array>} Array of historical daily data
     */
    async getHistoricalDailyData(days = 30) {
        try {
            logger.info(`[TELEPORTER HISTORICAL] Fetching historical daily data for last ${days} days`);
            
            // Calculate the date threshold
            const dateThreshold = new Date();
            dateThreshold.setDate(dateThreshold.getDate() - days);
            
            // Query for historical daily snapshots
            const historicalData = await TeleporterMessage.find({
                dataType: 'daily',
                updatedAt: { $gte: dateThreshold }
            })
            .sort({ updatedAt: -1 })
            .lean(); // Use lean() for better performance since we're not modifying the docs
            
            logger.info(`[TELEPORTER HISTORICAL] Found ${historicalData.length} daily snapshots in the last ${days} days`);
            
            // Group by date to handle potential duplicate entries on the same day
            const groupedByDate = new Map();
            
            historicalData.forEach(entry => {
                const entryDate = new Date(entry.updatedAt);
                const dateKey = `${entryDate.getFullYear()}-${(entryDate.getMonth() + 1).toString().padStart(2, '0')}-${entryDate.getDate().toString().padStart(2, '0')}`;
                
                // Keep only the most recent entry for each day
                if (!groupedByDate.has(dateKey) || 
                    new Date(entry.updatedAt) > new Date(groupedByDate.get(dateKey).updatedAt)) {
                    groupedByDate.set(dateKey, entry);
                }
            });
            
            // Convert back to array and sort by date (most recent first)
            const uniqueDailyData = Array.from(groupedByDate.values())
                .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            
            logger.info(`[TELEPORTER HISTORICAL] Returning ${uniqueDailyData.length} unique daily snapshots`);
            
            return uniqueDailyData;
            
        } catch (error) {
            logger.error('[TELEPORTER HISTORICAL] Error fetching historical daily data:', error);
            throw error;
        }
    }
}

module.exports = new TeleporterService();