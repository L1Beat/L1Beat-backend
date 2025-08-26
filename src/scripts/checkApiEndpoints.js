/**
 * Script to compare data from teleporter/messages and icm/messages endpoints
 * 
 * Usage: node src/scripts/checkApiEndpoints.js
 */

require('dotenv').config();

const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/config');

// Add console logging
function log(message, data = {}) {
  logger.info(message, data);
  console.log(message, data ? JSON.stringify(data) : '');
}

function logError(message, error) {
  logger.error(message, error);
  console.error(message, error ? JSON.stringify(error) : '');
}

// Constants for API requests
const GLACIER_API_BASE = process.env.GLACIER_API_BASE || config.api.glacier.baseUrl || 'https://glacier-api.avax.network/v1';
const GLACIER_API_KEY = process.env.GLACIER_API_KEY || config.api.glacier.apiKey;
const PAGE_SIZE = 100;  // Set a reasonable page size for quick comparison

// Calculate time range for last 24 hours
const now = Math.floor(Date.now() / 1000);
const startTime = now - (24 * 60 * 60);

// Log API key status (without revealing full key)
if (GLACIER_API_KEY) {
  const keyPrefix = GLACIER_API_KEY.substring(0, 6);
  const keySuffix = GLACIER_API_KEY.substring(GLACIER_API_KEY.length - 3);
  log(`Using Glacier API key: ${keyPrefix}...${keySuffix} (length: ${GLACIER_API_KEY.length})`);
} else {
  log('No Glacier API key found! Requests may be rate limited.');
}

/**
 * Fetch messages from a specific endpoint
 */
async function fetchMessages(endpoint) {
  try {
    log(`Fetching messages from ${endpoint} endpoint...`);
    
    // Log time window
    log(`Time window: ${new Date(startTime * 1000).toISOString()} to ${new Date(now * 1000).toISOString()}`);
    
    // Prepare headers with API key
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'l1beat-endpoint-checker'
    };
    
    // Add API key header if available
    if (GLACIER_API_KEY) {
      headers['x-glacier-api-key'] = GLACIER_API_KEY;
      headers['x-api-key'] = GLACIER_API_KEY; // Try alternative format
    }
    
    // Prepare request parameters
    const params = {
      startTime,
      endTime: now,
      pageSize: PAGE_SIZE,
      network: 'mainnet'
    };
    
    // Make request
    const url = `${GLACIER_API_BASE}/${endpoint}`;
    log(`Making request to: ${url}`);
    
    const response = await axios.get(url, {
      params,
      timeout: 30000,
      headers
    });
    
    if (!response.data || !response.data.messages) {
      throw new Error(`Invalid response from ${endpoint} endpoint`);
    }
    
    const messages = response.data.messages;
    
    // Log basic message info
    log(`Received ${messages.length} messages from ${endpoint} endpoint`);
    
    if (messages.length > 0) {
      const firstMessage = messages[0];
      const lastMessage = messages[messages.length - 1];
      
      // Extract timestamps
      const firstTimestamp = firstMessage.sourceTransaction?.timestamp ||
                            firstMessage.timestamp ||
                            'unknown';
      const lastTimestamp = lastMessage.sourceTransaction?.timestamp ||
                           lastMessage.timestamp ||
                           'unknown';
      
      // Log timestamp range of messages
      if (firstTimestamp !== 'unknown' && lastTimestamp !== 'unknown') {
        let firstTime = firstTimestamp;
        let lastTime = lastTimestamp;
        
        // Convert ms to seconds if needed
        if (firstTime > 1000000000000) firstTime = Math.floor(firstTime / 1000);
        if (lastTime > 1000000000000) lastTime = Math.floor(lastTime / 1000);
        
        log(`Message time range: ${new Date(firstTime * 1000).toISOString()} to ${new Date(lastTime * 1000).toISOString()}`);
      }
      
      // Log sample message keys
      log(`Sample message keys: ${Object.keys(firstMessage).join(', ')}`);
      
      // Count unique source/dest chains
      const sourceDest = new Set();
      messages.forEach(message => {
        if (message.sourceBlockchainId && message.destinationBlockchainId) {
          sourceDest.add(`${message.sourceBlockchainId}|${message.destinationBlockchainId}`);
        }
      });
      
      log(`Unique source/destination pairs: ${sourceDest.size}`);
    }
    
    return {
      count: messages.length,
      hasNextPage: !!response.data.nextPageToken
    };
    
  } catch (error) {
    logError(`Error fetching from ${endpoint}:`, {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    return { error: error.message };
  }
}

/**
 * Compare both endpoints
 */
async function compareEndpoints() {
  try {
    log('=== COMPARING GLACIER API ENDPOINTS ===');
    
    // Fetch from teleporter/messages
    const teleporterResult = await fetchMessages('teleporter/messages');
    
    // Fetch from icm/messages
    const icmResult = await fetchMessages('icm/messages');
    
    // Compare results
    log('=== RESULTS COMPARISON ===');
    log(`teleporter/messages: ${teleporterResult.count} messages (has more pages: ${teleporterResult.hasNextPage})`);
    log(`icm/messages: ${icmResult.count} messages (has more pages: ${icmResult.hasNextPage})`);
    
    // Calculate difference
    const difference = teleporterResult.count - icmResult.count;
    const percentDiff = teleporterResult.count > 0 ? 
      Math.abs(difference) / Math.max(teleporterResult.count, icmResult.count) * 100 : 
      'N/A';
    
    log(`Difference: ${difference} messages (${percentDiff.toFixed(2)}%)`);
    log('============================');
    
    process.exit(0);
  } catch (error) {
    logError('Error comparing endpoints:', {
      message: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Run the comparison
compareEndpoints(); 