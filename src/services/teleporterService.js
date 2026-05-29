const axios = require('axios');
const config = require('../config/config');
const logger = require('../utils/logger');
const { TeleporterMessage, TeleporterUpdateState } = require('../models/teleporterMessage');

class TeleporterService {
    constructor() {
        this.GLACIER_API_BASE = process.env.GLACIER_API_BASE || config.api.glacier.baseUrl;
        this.GLACIER_API_KEY = process.env.GLACIER_API_KEY;
        this.UPDATE_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
        this.TIMEOUT_DAILY = 120000; // 120 seconds for daily updates (API is slow)
        this.TIMEOUT_WEEKLY = 120000; // 120 seconds for weekly updates
        this._periodicUpdatesStarted = false;

        if (!this.GLACIER_API_KEY) {
            logger.warn('GLACIER_API_KEY not found in environment variables');
        }

        if (!this.GLACIER_API_BASE) {
            logger.error('GLACIER_API_BASE not configured');
        }

        logger.info('TeleporterService initialized', {
            hasApiKey: !!this.GLACIER_API_KEY,
            apiBase: this.GLACIER_API_BASE,
            timeouts: {
                daily: `${this.TIMEOUT_DAILY / 1000}s`,
                weekly: `${this.TIMEOUT_WEEKLY / 1000}s`
            }
        });
    }

    /**
     * Fetch ICM messages from Glacier API
     * @param {number} hoursAgo - How many hours ago to start fetching from
     * @param {string} updateType - Type of update ('daily' or 'weekly') for logging
     * @param {Function} ownershipCheck - Optional async function that returns false if we should stop
     * @returns {Promise<Array>} Array of messages
     */
    async fetchICMMessages(hoursAgo = 24, updateType = 'daily', ownershipCheck = null) {
        const endTime = Math.floor(Date.now() / 1000);
        const startTime = endTime - (hoursAgo * 60 * 60);
        return this.fetchICMMessagesInWindow(startTime, endTime, updateType, ownershipCheck);
    }

    /**
     * Fetch ICM messages for an explicit [startTime, endTime] window (unix seconds).
     * This is the pagination core shared by daily fetches and resumable weekly
     * day-by-day fetches.
     * @param {number} startTime - Window start (unix seconds, inclusive)
     * @param {number} endTime - Window end (unix seconds, inclusive)
     * @param {string} updateType - Type of update ('daily' or 'weekly') for logging/timeout
     * @param {Function} ownershipCheck - Optional async function that returns false if we should stop
     * @returns {Promise<Array>} Array of messages within the window
     */
    async fetchICMMessagesInWindow(startTime, endTime, updateType = 'weekly', ownershipCheck = null) {
        try {
            const updateLabel = updateType.toUpperCase();
            const hoursAgo = Math.max(1, Math.round((endTime - startTime) / (60 * 60)));

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

            logger.info(`[TELEPORTER ${updateLabel}] Fetching ICM messages from last ${hoursAgo} hours`, {
                startTime,
                endTime,
                startTimeISO: new Date(startTime * 1000).toISOString(),
                endTimeISO: new Date(endTime * 1000).toISOString(),
                timeRange: `${hoursAgo} hours (${Math.round(hoursAgo / 24)} days)`
            });

            let allMessages = [];
            let nextPageToken = null;
            let pageCount = 0;
            const maxPages = 1000; // Higher safety limit
            let reachedTimeLimit = false;
            const fetchStartTime = Date.now();

            do {
                // Check if we still own the lock
                if (ownershipCheck) {
                    const stillOwnsLock = await ownershipCheck();
                    if (!stillOwnsLock) {
                        logger.warn(`[TELEPORTER ${updateLabel}] Lost ownership of lock, aborting update`);
                        throw new Error('Lost ownership of update lock');
                    }
                }

                pageCount++;
                const pageStartTime = Date.now();

                if (nextPageToken) {
                    params.pageToken = nextPageToken;
                }

                // Use longer timeout for weekly updates
                const timeout = updateType === 'weekly' ? this.TIMEOUT_WEEKLY : this.TIMEOUT_DAILY;

                // Retry logic for timeout errors
                let response;
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount <= maxRetries) {
                    try {
                        response = await axios.get(`${this.GLACIER_API_BASE}/icm/messages`, {
                            headers,
                            params,
                            timeout
                        });
                        break; // Success, exit retry loop
                    } catch (error) {
                        // Retry on timeout, network errors, or temporary server errors
                        const errorCode = error.code || error.cause?.code;
                        const isNetworkError = errorCode === 'ECONNABORTED' ||
                                              errorCode === 'ECONNRESET' ||
                                              errorCode === 'ETIMEDOUT' ||
                                              errorCode === 'ENOTFOUND' ||
                                              error.message?.includes('socket hang up');

                        const isServerError = error.response?.status === 502 || // Bad Gateway
                                            error.response?.status === 503 || // Service Unavailable
                                            error.response?.status === 504;   // Gateway Timeout

                        const isRateLimitError = error.response?.status === 429; // Too Many Requests

                        const isRetryableError = isNetworkError || isServerError || isRateLimitError;

                        if (isRetryableError && retryCount < maxRetries) {
                            retryCount++;
                            // Use longer backoff for rate limit errors (30-60s), shorter for others (2-10s)
                            let waitTime;
                            if (isRateLimitError) {
                                waitTime = 30000 + (retryCount * 15000); // 30s, 45s, 60s for rate limits
                            } else {
                                waitTime = Math.min(1000 * Math.pow(2, retryCount), 10000); // Exponential backoff, max 10s
                            }
                            const errorType = error.response?.status ? `HTTP ${error.response.status}` : errorCode || 'network error';
                            logger.warn(`[TELEPORTER ${updateLabel}] Page ${pageCount} ${errorType} (attempt ${retryCount}/${maxRetries + 1}), retrying in ${waitTime / 1000}s...`, {
                                error: error.message,
                                errorCode: errorCode,
                                status: error.response?.status,
                                timeout: `${timeout / 1000}s`,
                                pageToken: nextPageToken ? 'present' : 'none',
                                isRateLimitError
                            });
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                        } else {
                            throw error; // Throw if not retryable or max retries reached
                        }
                    }
                }

                const pageFetchTime = ((Date.now() - pageStartTime) / 1000).toFixed(2);
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

                    // Check if the message is within our time range. The upper
                    // bound matters for windowed weekly fetches (endTime < now);
                    // for daily fetches endTime is "now" so it is a no-op.
                    if (timestampInSeconds >= startTime && timestampInSeconds <= endTime) {
                        validMessages.push(message);
                    }
                    // Don't stop on individual old messages - they may not be chronological
                }

                // Add valid messages from this page to our collection
                allMessages = allMessages.concat(validMessages);
                nextPageToken = response.data?.nextPageToken;

                // Only stop if we got a full page with NO valid messages
                // This means we've definitely gone past our time range
                if (validMessages.length === 0 && messages.length > 0) {
                    reachedTimeLimit = true;
                    logger.info(`[TELEPORTER ${updateLabel}] Full page of old messages (0/${messages.length} valid), stopping pagination`, {
                        page: pageCount
                    });
                }

                // Calculate estimated time remaining for weekly updates
                const elapsedTime = (Date.now() - fetchStartTime) / 1000;
                const avgTimePerPage = elapsedTime / pageCount;
                const estimatedPagesRemaining = updateType === 'weekly' ? Math.max(0, (hoursAgo / 24 * 100) - pageCount) : 0;
                const estimatedTimeRemaining = estimatedPagesRemaining * avgTimePerPage / 60;

                logger.info(`[TELEPORTER ${updateLabel}] Page ${pageCount} fetched in ${pageFetchTime}s: ${messages.length} messages (${validMessages.length} valid)`, {
                    totalMessages: allMessages.length,
                    hasNextPage: !!nextPageToken,
                    reachedTimeLimit,
                    avgTimePerPage: `${avgTimePerPage.toFixed(2)}s`,
                    ...(updateType === 'weekly' && estimatedPagesRemaining > 0 ? {
                        estimatedPagesRemaining,
                        estimatedTimeRemaining: `~${Math.ceil(estimatedTimeRemaining)} min`
                    } : {})
                });

                // Update heartbeat every 10 pages to signal the update is still alive
                // This prevents the controller from marking the update as stale
                if (ownershipCheck && pageCount % 10 === 0) {
                    try {
                        await TeleporterUpdateState.updateOne(
                            { updateType, state: 'in_progress' },
                            { $set: { lastUpdatedAt: new Date() } }
                        );
                        logger.debug(`[TELEPORTER ${updateLabel}] Heartbeat updated at page ${pageCount}`);
                    } catch (heartbeatError) {
                        logger.warn(`[TELEPORTER ${updateLabel}] Failed to update heartbeat:`, heartbeatError.message);
                    }
                }

                // If we reached the time limit, stop pagination
                if (reachedTimeLimit) {
                    logger.info(`[TELEPORTER ${updateLabel}] Reached time limit (${hoursAgo} hours), stopping pagination`);
                    break;
                }

                // Safety check to prevent infinite loops (should rarely be hit now)
                if (pageCount >= maxPages) {
                    logger.warn(`[TELEPORTER ${updateLabel}] Reached maximum page limit (${maxPages}), stopping pagination`);
                    break;
                }

                // Small delay between requests to be respectful to the API
                if (nextPageToken) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

            } while (nextPageToken);

            const totalFetchTime = ((Date.now() - fetchStartTime) / 1000 / 60).toFixed(2);
            logger.info(`[TELEPORTER ${updateLabel}] ✅ Completed fetching: ${allMessages.length} messages from ${pageCount} pages in ${totalFetchTime} minutes`, {
                reachedTimeLimit,
                hitPageLimit: pageCount >= maxPages,
                avgTimePerPage: `${((Date.now() - fetchStartTime) / 1000 / pageCount).toFixed(2)}s`
            });
            return allMessages;

        } catch (error) {
            const updateLabel = updateType ? updateType.toUpperCase() : 'UNKNOWN';
            // Safely access pageCount and allMessages in case error occurred before they were initialized
            const currentPageCount = typeof pageCount !== 'undefined' ? pageCount : 0;
            const currentMessageCount = typeof allMessages !== 'undefined' ? allMessages.length : 0;

            logger.error(`[TELEPORTER ${updateLabel}] Error fetching ICM messages:`, {
                message: error.message,
                code: error.code,
                status: error.response?.status,
                statusText: error.response?.statusText,
                isTimeout: error.code === 'ECONNABORTED',
                pageCount: currentPageCount,
                totalMessages: currentMessageCount
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
                timeout: this.TIMEOUT_DAILY, // Use daily timeout for internal API calls
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'l1beat-backend-internal'
                }
            });

            const chains = response.data || [];
            const mapping = {};

            for (const chain of chains) {
                if (chain.evmChainId && chain.chainName) {
                    mapping[chain.evmChainId] = chain.chainName;
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

            // Clean up duplicates first
            const duplicates = await TeleporterUpdateState.find({ updateType: 'daily' }).sort({ startedAt: -1 });
            if (duplicates.length > 1) {
                logger.warn(`[TELEPORTER DAILY] Found ${duplicates.length} duplicate state documents, cleaning up...`);
                // Keep the most recent one, delete others
                const idsToDelete = duplicates.slice(1).map(d => d._id);
                await TeleporterUpdateState.deleteMany({ _id: { $in: idsToDelete } });
            }

            // First, clean up any stale updates (older than 60 minutes)
            // Daily updates typically complete in 30-40 minutes, so 60 min is safe buffer
            const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
            await TeleporterUpdateState.updateMany(
                {
                    updateType: 'daily',
                    state: 'in_progress',
                    lastUpdatedAt: { $lt: sixtyMinutesAgo }
                },
                {
                    $set: {
                        state: 'failed',
                        error: { message: 'Update timed out (stale cleanup)' },
                        lastUpdatedAt: new Date()
                    }
                }
            );

            // Ensure state document exists (idempotent operation)
            try {
                await TeleporterUpdateState.updateOne(
                    { updateType: 'daily' },
                    {
                        $setOnInsert: {
                            updateType: 'daily',
                            state: 'idle',
                            startedAt: null,
                            lastUpdatedAt: new Date(),
                            error: null
                        }
                    },
                    { upsert: true }
                );
            } catch (err) {
                // Ignore duplicate key error if race condition occurs
                if (err.code !== 11000) throw err;
            }

            // Try to atomically acquire the lock (without upsert to prevent duplicate documents)
            const updateState = await TeleporterUpdateState.findOneAndUpdate(
                {
                    updateType: 'daily',
                    state: { $ne: 'in_progress' } // Only proceed if not already in_progress
                },
                {
                    $set: {
                        state: 'in_progress',
                        startedAt: new Date(),
                        lastUpdatedAt: new Date(),
                        error: null
                    }
                },
                {
                    new: true,     // Return the updated document
                    returnDocument: 'after'
                }
            );

            // If findOneAndUpdate returned null, lock acquisition failed (another process has the lock)
            if (!updateState) {
                logger.info('[TELEPORTER DAILY] Update already in progress (atomic lock), skipping');
                return { success: true, status: 'in_progress' };
            }

            logger.info('[TELEPORTER DAILY] Acquired update lock, proceeding with update');

            const ownershipCheck = async () => {
                try {
                    const currentStatus = await TeleporterUpdateState.findOne({ updateType: 'daily' });
                    if (!currentStatus || currentStatus.state !== 'in_progress') return false;
                    // Allow 2s drift
                    return Math.abs(currentStatus.startedAt.getTime() - updateState.startedAt.getTime()) < 2000;
                } catch (err) {
                    logger.error('[TELEPORTER DAILY] Error in ownership check:', err);
                    return true;
                }
            };

            logger.info('[TELEPORTER DAILY] Fetching ICM messages for last 24 hours...');
            // Fetch and process messages
            const messages = await this.fetchICMMessages(24, 'daily', ownershipCheck);
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
            try {
                // If the error IS "Lost ownership", we definitely shouldn't touch the DB.
                if (error.message === 'Lost ownership of update lock') {
                    logger.warn('[TELEPORTER DAILY] Not updating DB state as lock was lost');
                } else {
                    const updateState = await TeleporterUpdateState.findOne({ updateType: 'daily' });
                    if (updateState && updateState.state === 'in_progress') {
                        updateState.state = 'failed';
                        updateState.error = { message: error.message };
                        updateState.lastUpdatedAt = new Date();
                        await updateState.save();
                    }
                }
            } catch (dbError) {
                logger.error('[TELEPORTER DAILY] Error updating failure state:', dbError);
            }

            throw error;
        }
    }

    /**
     * Update weekly teleporter data (last 7 days)
     */
    /**
     * Compute the [startTime, endTime] window (unix seconds) for a given day of
     * the weekly fetch, anchored to a fixed reference end time.
     * Day 1 is the most recent 24h; day 7 is the oldest.
     * @param {number} anchorEndTime - Reference end of the 7-day window (unix seconds)
     * @param {number} day - 1-based day index (1..7)
     * @returns {{startTime: number, endTime: number}}
     */
    getWeeklyDayWindow(anchorEndTime, day) {
        const DAY_SECONDS = 24 * 60 * 60;
        return {
            startTime: anchorEndTime - (day * DAY_SECONDS),
            endTime: anchorEndTime - ((day - 1) * DAY_SECONDS)
        };
    }

    /**
     * Merge per-day partial results into a single aggregated weekly result.
     * Sums message counts per chain pair across all days and totals the raw
     * message count. Pure function (no I/O) so it is easy to unit test.
     * @param {Array} partialResults - Array of { messageCount: [{sourceChain, destinationChain, messageCount}], totalMessages }
     * @returns {{messageCounts: Array, totalMessages: number}}
     */
    mergePartialResults(partialResults) {
        const counts = {};
        let totalMessages = 0;

        for (const dayResult of partialResults || []) {
            totalMessages += dayResult.totalMessages || 0;
            for (const pair of dayResult.messageCount || []) {
                const key = `${pair.sourceChain}|${pair.destinationChain}`;
                if (!counts[key]) {
                    counts[key] = {
                        sourceChain: pair.sourceChain,
                        destinationChain: pair.destinationChain,
                        messageCount: 0
                    };
                }
                counts[key].messageCount += pair.messageCount;
            }
        }

        const messageCounts = Object.values(counts).sort((a, b) => b.messageCount - a.messageCount);
        return { messageCounts, totalMessages };
    }

    async updateWeeklyData() {
        try {
            logger.info('[TELEPORTER WEEKLY] Starting weekly teleporter data update (last 7 days)');

            // Clean up duplicates first
            const duplicates = await TeleporterUpdateState.find({ updateType: 'weekly' }).sort({ startedAt: -1 });
            if (duplicates.length > 1) {
                logger.warn(`[TELEPORTER WEEKLY] Found ${duplicates.length} duplicate state documents, cleaning up...`);
                // Keep the most recent one, delete others
                const idsToDelete = duplicates.slice(1).map(d => d._id);
                await TeleporterUpdateState.deleteMany({ _id: { $in: idsToDelete } });
            }

            // First, clean up any stale updates (older than 8 hours)
            // Weekly updates can take 4-6 hours with retries, so 8 hours is safe buffer
            const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
            await TeleporterUpdateState.updateMany(
                {
                    updateType: 'weekly',
                    state: 'in_progress',
                    lastUpdatedAt: { $lt: eightHoursAgo }
                },
                {
                    $set: {
                        state: 'failed',
                        error: { message: 'Update timed out (stale cleanup)' },
                        lastUpdatedAt: new Date()
                    }
                }
            );

            // Ensure state document exists (idempotent operation)
            try {
                await TeleporterUpdateState.updateOne(
                    { updateType: 'weekly' },
                    {
                        $setOnInsert: {
                            updateType: 'weekly',
                            state: 'idle',
                            startedAt: null,
                            lastUpdatedAt: new Date(),
                            error: null
                        }
                    },
                    { upsert: true }
                );
            } catch (err) {
                // Ignore duplicate key error if race condition occurs
                if (err.code !== 11000) throw err;
            }

            // Try to atomically acquire the lock (without upsert to prevent duplicate documents)
            const updateState = await TeleporterUpdateState.findOneAndUpdate(
                {
                    updateType: 'weekly',
                    state: { $ne: 'in_progress' } // Only proceed if not already in_progress
                },
                {
                    $set: {
                        state: 'in_progress',
                        startedAt: new Date(),
                        lastUpdatedAt: new Date(),
                        error: null
                    }
                },
                {
                    new: true,     // Return the updated document
                    returnDocument: 'after'
                }
            );

            // If findOneAndUpdate returned null, lock acquisition failed (another process has the lock)
            if (!updateState) {
                logger.info('[TELEPORTER WEEKLY] Weekly update already in progress (atomic lock), skipping');
                return { success: true, status: 'in_progress' };
            }

            logger.info('[TELEPORTER WEEKLY] Acquired update lock, proceeding with update');

            const ownershipCheck = async () => {
                try {
                    const currentStatus = await TeleporterUpdateState.findOne({ updateType: 'weekly' });
                    if (!currentStatus || currentStatus.state !== 'in_progress') return false;
                    // Allow 2s drift
                    return Math.abs(currentStatus.startedAt.getTime() - updateState.startedAt.getTime()) < 2000;
                } catch (err) {
                    logger.error('[TELEPORTER WEEKLY] Error in ownership check:', err);
                    return true;
                }
            };

            // The 7-day fetch is split into 7 independent day-windows. Each
            // completed day is persisted to partialResults so that if the
            // process restarts mid-update (e.g. a redeploy), the next run
            // resumes from the next unfetched day instead of starting over.
            const WEEKLY_DAYS = 7;
            const MAX_RESUME_AGE_MS = 24 * 60 * 60 * 1000; // Resume only if the run is still recent.

            if (!updateState.progress) {
                updateState.progress = {
                    currentDay: 1, totalDays: WEEKLY_DAYS, daysCompleted: 0,
                    currentChunk: 0, totalChunks: 6, messagesCollected: 0
                };
            }

            const priorDaysCompleted = updateState.progress.daysCompleted || 0;
            const priorPartial = Array.isArray(updateState.partialResults) ? updateState.partialResults : [];
            const refEnd = updateState.referenceEndTime;
            const canResume = priorDaysCompleted >= 1 &&
                priorDaysCompleted < WEEKLY_DAYS &&
                refEnd &&
                priorPartial.length === priorDaysCompleted &&
                (Date.now() - new Date(refEnd).getTime()) < MAX_RESUME_AGE_MS;

            let anchorEndTime;
            let daysCompleted;
            let partial;

            if (canResume) {
                anchorEndTime = Math.floor(new Date(refEnd).getTime() / 1000);
                daysCompleted = priorDaysCompleted;
                // Keep prior days as plain objects so merge/save are independent of Mongoose subdocs.
                partial = priorPartial.map(p => ({
                    day: p.day,
                    messageCount: (p.messageCount || []).map(m => ({
                        sourceChain: m.sourceChain,
                        destinationChain: m.destinationChain,
                        messageCount: m.messageCount
                    })),
                    totalMessages: p.totalMessages,
                    startHoursAgo: p.startHoursAgo,
                    endHoursAgo: p.endHoursAgo,
                    processedAt: p.processedAt
                }));
                logger.info(`[TELEPORTER WEEKLY] Resuming update: ${daysCompleted}/${WEEKLY_DAYS} days already collected, continuing from day ${daysCompleted + 1}`);
            } else {
                anchorEndTime = Math.floor(Date.now() / 1000);
                daysCompleted = 0;
                partial = [];
                updateState.referenceEndTime = new Date(anchorEndTime * 1000);
                updateState.partialResults = [];
                updateState.progress.daysCompleted = 0;
                updateState.progress.currentDay = 1;
                updateState.progress.messagesCollected = 0;
                await updateState.save();
                logger.info(`[TELEPORTER WEEKLY] Starting fresh 7-day fetch (anchor ${new Date(anchorEndTime * 1000).toISOString()})`);
            }

            for (let day = daysCompleted + 1; day <= WEEKLY_DAYS; day++) {
                // Stop immediately if another process took over the lock.
                if (!(await ownershipCheck())) {
                    throw new Error('Lost ownership of update lock');
                }

                const { startTime, endTime } = this.getWeeklyDayWindow(anchorEndTime, day);
                logger.info(`[TELEPORTER WEEKLY] Fetching day ${day}/${WEEKLY_DAYS} (${new Date(startTime * 1000).toISOString()} → ${new Date(endTime * 1000).toISOString()})`);

                const dayMessages = await this.fetchICMMessagesInWindow(startTime, endTime, 'weekly', ownershipCheck);
                const dayProcessed = await this.processMessages(dayMessages);

                partial.push({
                    day,
                    messageCount: dayProcessed,
                    totalMessages: dayMessages.length,
                    startHoursAgo: day * 24,
                    endHoursAgo: (day - 1) * 24,
                    processedAt: new Date()
                });

                // Checkpoint this day so a restart resumes from the next one.
                updateState.partialResults = partial;
                updateState.progress.daysCompleted = day;
                updateState.progress.currentDay = day + 1;
                updateState.progress.messagesCollected = partial.reduce((sum, p) => sum + (p.totalMessages || 0), 0);
                updateState.lastUpdatedAt = new Date();
                await updateState.save();

                logger.info(`[TELEPORTER WEEKLY] ✅ Day ${day}/${WEEKLY_DAYS} complete: ${dayMessages.length} messages, ${dayProcessed.length} chain pairs (${partial.reduce((s, p) => s + (p.totalMessages || 0), 0)} messages so far)`);
            }

            // All days collected — merge into the final weekly aggregate.
            const merged = this.mergePartialResults(partial);
            logger.info(`[TELEPORTER WEEKLY] Merged ${WEEKLY_DAYS} days into ${merged.messageCounts.length} unique chain pairs (${merged.totalMessages} total messages)`);

            // Save to database (replace existing weekly data)
            await TeleporterMessage.deleteMany({ dataType: 'weekly' });

            const teleporterData = new TeleporterMessage({
                updatedAt: new Date(),
                messageCounts: merged.messageCounts,
                totalMessages: merged.totalMessages,
                timeWindow: 168,
                dataType: 'weekly'
            });
            await teleporterData.save();

            // Update state to completed and clear the resume checkpoint.
            updateState.state = 'completed';
            updateState.partialResults = [];
            updateState.referenceEndTime = null;
            updateState.lastUpdatedAt = new Date();
            await updateState.save();

            logger.info(`[TELEPORTER WEEKLY] ✅ Successfully completed weekly update: ${merged.totalMessages} messages, ${merged.messageCounts.length} chain pairs`);

            return {
                success: true,
                messageCount: merged.messageCounts.length,
                totalMessages: merged.totalMessages
            };

        } catch (error) {
            logger.error('[TELEPORTER WEEKLY] ❌ Error updating weekly data:', error);

            // Update state to failed
            try {
                // If the error IS "Lost ownership", we definitely shouldn't touch the DB.
                if (error.message === 'Lost ownership of update lock') {
                    logger.warn('[TELEPORTER WEEKLY] Not updating DB state as lock was lost');
                } else {
                    const updateState = await TeleporterUpdateState.findOne({ updateType: 'weekly' });
                    if (updateState && updateState.state === 'in_progress') {
                        updateState.state = 'failed';
                        updateState.error = { message: error.message };
                        updateState.lastUpdatedAt = new Date();
                        await updateState.save();
                    }
                }
            } catch (dbError) {
                logger.error('[TELEPORTER WEEKLY] Error updating failure state:', dbError);
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

            // Check if an update is already in progress before triggering a new one
            const updateState = await TeleporterUpdateState.findOne({ updateType: 'weekly' });
            const updateInProgress = updateState && updateState.state === 'in_progress';

            if (data) {
                const age = Date.now() - new Date(data.updatedAt).getTime();
                
                // If data is older than 6 hours AND no update is in progress, trigger background update
                if (age > 6 * 60 * 60 * 1000 && !updateInProgress) {
                    logger.info('[TELEPORTER WEEKLY] Weekly data is older than 6 hours, triggering background update');
                    this.updateWeeklyData().catch(err => {
                        logger.error('[TELEPORTER WEEKLY] Background weekly update failed:', err);
                    });
                } else if (age > 6 * 60 * 60 * 1000 && updateInProgress) {
                    logger.debug('[TELEPORTER WEEKLY] Weekly data is older than 6 hours, but update already in progress');
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

            // If no data exists and no update is in progress, trigger update and return empty result
            if (!updateInProgress) {
                logger.info('[TELEPORTER WEEKLY] No weekly data found, triggering initial update');
                this.updateWeeklyData().catch(err => {
                    logger.error('[TELEPORTER WEEKLY] Initial weekly update failed:', err);
                });
            } else {
                logger.debug('[TELEPORTER WEEKLY] No weekly data found, but update already in progress');
            }

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
        if (this._periodicUpdatesStarted) {
            logger.warn('startPeriodicUpdates() called more than once, ignoring');
            return;
        }
        this._periodicUpdatesStarted = true;

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