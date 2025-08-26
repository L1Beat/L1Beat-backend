/**
 * Script to check cross-chain message counts from Glacier API for a specific date
 * 
 * Usage: node src/scripts/checkGlacierTransactions.js --date=2025-04-28
 */

require('dotenv').config();

const axios = require('axios');
const config = require('../config/config');
const logger = require('../utils/logger');

// Parse command line arguments
const args = process.argv.slice(2).reduce((result, arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  result[key] = value;
  return result;
}, {});

// Get date from args or use yesterday
const targetDate = args.date ? new Date(args.date) : new Date(Date.now() - 86400000);
const formattedDate = targetDate.toISOString().split('T')[0];

// Constants for API requests
const GLACIER_API_BASE = process.env.GLACIER_API_BASE || config.api.glacier.baseUrl;
const GLACIER_API_KEY = process.env.GLACIER_API_KEY || config.api.glacier.apiKey;
const PAGE_SIZE = 100; // Maximum page size for efficiency
const MAX_PAGES = 1000; // Higher limit to try to get all data
const MAX_RETRIES = 3;

// Log API key status (without revealing full key)
if (GLACIER_API_KEY) {
  const keyPrefix = GLACIER_API_KEY.substring(0, 6);
  const keySuffix = GLACIER_API_KEY.substring(GLACIER_API_KEY.length - 3);
  logger.info(`Using Glacier API key: ${keyPrefix}...${keySuffix} (length: ${GLACIER_API_KEY.length})`);
} else {
  logger.warn('No Glacier API key found! Requests may be rate limited.');
}

// Sleep function for rate limiting
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch cross-chain messages and filter for the specified date
 */
async function fetchMessagesForDate(date) {
  try {
    logger.info(`Fetching cross-chain messages and filtering for ${formattedDate}`);
    
    // Calculate time range for the target date (00:00:00 to 23:59:59)
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);
    
    const startTime = Math.floor(startDate.getTime() / 1000);
    const endTime = Math.floor(endDate.getTime() / 1000);
    
    logger.info(`Looking for messages between: ${new Date(startTime * 1000).toISOString()} and ${new Date(endTime * 1000).toISOString()}`);
    
    let allMessages = [];
    let dateFilteredMessages = [];
    let nextPageToken = null;
    let pageCount = 0;
    let hitPageLimit = false;
    let continueSearch = true;
    
    // Statistics
    let messagesByChain = {};
    let messagesSent = 0;
    let messagesReceived = 0;
    
    // Fetch pages until there are no more, we hit the limit, or we find an old enough message
    do {
      pageCount++;
      let retryCount = 0;
      let success = false;
      
      while (!success && retryCount <= MAX_RETRIES) {
        try {
          // Add delay for subsequent requests
          if (nextPageToken || retryCount > 0) {
            const delay = retryCount === 0 ? 1000 : 2000 * Math.pow(2, retryCount - 1);
            logger.info(`Waiting ${delay}ms before ${retryCount > 0 ? 'retry' : 'next page'}...`);
            await sleep(delay);
          }
          
          // Prepare request parameters
          const params = {
            pageSize: PAGE_SIZE,
            network: 'mainnet'
          };
          
          if (nextPageToken) {
            params.pageToken = nextPageToken;
          }
          
          // Prepare headers with API key
          const headers = {
            'Accept': 'application/json',
            'User-Agent': 'l1beat-transaction-checker'
          };
          
          // Add API key in both formats to ensure it works
          if (GLACIER_API_KEY) {
            headers['x-glacier-api-key'] = GLACIER_API_KEY;
            headers['x-api-key'] = GLACIER_API_KEY; // Alternative format
          }
          
          // Use the icm/messages endpoint instead of teleporter/messages
          const url = `${GLACIER_API_BASE}/icm/messages`;
          logger.info(`Requesting: ${url} (page ${pageCount})`);
          
          const response = await axios.get(url, {
            params,
            timeout: 30000,
            headers
          });
          
          if (!response.data || !response.data.messages) {
            throw new Error('Invalid response from Glacier API');
          }
          
          const messages = response.data.messages;
          logger.info(`Received ${messages.length} messages (page ${pageCount})`);
          
          if (messages.length === 0) {
            logger.info('No more messages to fetch');
            continueSearch = false;
            break;
          }
          
          // Check message timestamps and filter for target date
          let foundMessagesForDate = false;
          let allMessagesOlder = true;
          let latestTimestamp = 0;
          let earliestTimestamp = Number.MAX_SAFE_INTEGER;
          
          messages.forEach(message => {
            // Get message timestamp from sourceTransaction
            let messageTimestamp = null;
            
            if (message.sourceTransaction && message.sourceTransaction.timestamp) {
              messageTimestamp = message.sourceTransaction.timestamp;
            } else if (message.destinationTransaction && message.destinationTransaction.timestamp) {
              messageTimestamp = message.destinationTransaction.timestamp;
            } else if (message.timestamp) {
              messageTimestamp = message.timestamp;
            }
            
            // Convert timestamp to seconds if it's in milliseconds
            if (messageTimestamp && messageTimestamp > 1000000000000) {
              messageTimestamp = Math.floor(messageTimestamp / 1000);
            }
            
            // Record latest/earliest timestamps for logging
            if (messageTimestamp) {
              latestTimestamp = Math.max(latestTimestamp, messageTimestamp);
              earliestTimestamp = Math.min(earliestTimestamp, messageTimestamp);
              
              // Check if message is within target date range
              if (messageTimestamp >= startTime && messageTimestamp <= endTime) {
                foundMessagesForDate = true;
                
                // Add to filtered messages
                dateFilteredMessages.push(message);
                
                // Process source chain
                const sourceChain = message.sourceEvmChainId || message.sourceBlockchainId;
                if (!messagesByChain[sourceChain]) {
                  messagesByChain[sourceChain] = { sent: 0, received: 0 };
                }
                messagesByChain[sourceChain].sent++;
                messagesSent++;
                
                // Process destination chain
                const destChain = message.destinationEvmChainId || message.destinationBlockchainId;
                if (!messagesByChain[destChain]) {
                  messagesByChain[destChain] = { sent: 0, received: 0 };
                }
                messagesByChain[destChain].received++;
                messagesReceived++;
              }
              
              // Check if message is newer than our target date (still need to keep searching)
              if (messageTimestamp > endTime) {
                allMessagesOlder = false;
              }
            }
          });
          
          // Log the timestamp range in this batch
          if (latestTimestamp > 0 && earliestTimestamp < Number.MAX_SAFE_INTEGER) {
            logger.info(`This batch contains messages from ${new Date(earliestTimestamp * 1000).toISOString()} to ${new Date(latestTimestamp * 1000).toISOString()}`);
          }
          
          // Add all messages to the complete collection
          allMessages = [...allMessages, ...messages];
          
          // Track if we found messages for our target date
          if (foundMessagesForDate) {
            logger.info(`Found ${dateFilteredMessages.length} messages for target date ${formattedDate} so far`);
          }
          
          // Decide whether to continue searching
          // If all messages in this batch are older than our end date and we didn't find any matches,
          // we can probably stop (assuming messages are returned in chronological order)
          if (allMessagesOlder && !foundMessagesForDate && pageCount > 3) {
            logger.info('All messages older than target date and no matches found, stopping search');
            continueSearch = false;
            break;
          }
          
          nextPageToken = response.data.nextPageToken;
          success = true;
          
          // If no next page token, we're done
          if (!nextPageToken) {
            continueSearch = false;
          }
          
        } catch (error) {
          retryCount++;
          logger.error(`Error fetching page ${pageCount}: ${error.message}`);
          
          if (retryCount > MAX_RETRIES) {
            logger.error(`Max retries exceeded for page ${pageCount}`);
            break;
          }
        }
      }
      
      // If we couldn't fetch this page after retries, stop pagination
      if (!success) {
        break;
      }
      
      // Stop if we've reached the maximum number of pages
      if (pageCount >= MAX_PAGES) {
        hitPageLimit = true;
        logger.warn(`Reached maximum page limit (${MAX_PAGES})`);
        break;
      }
      
    } while (nextPageToken && continueSearch);
    
    // Print summary
    logger.info('===== CROSS-CHAIN MESSAGE SUMMARY =====');
    logger.info(`Date: ${formattedDate}`);
    logger.info(`Total API messages fetched: ${allMessages.length}`);
    logger.info(`Messages matching target date: ${dateFilteredMessages.length}`);
    logger.info(`Pages retrieved: ${pageCount}`);
    logger.info(`Hit page limit: ${hitPageLimit}`);
    logger.info('');
    logger.info('Messages by chain:');
    
    Object.entries(messagesByChain).forEach(([chain, counts]) => {
      logger.info(`  ${chain}: sent=${counts.sent}, received=${counts.received}`);
    });
    
    logger.info('');
    logger.info(`Total sent: ${messagesSent}`);
    logger.info(`Total received: ${messagesReceived}`);
    logger.info('=====================================');
    
    return {
      totalMessages: dateFilteredMessages.length,
      messagesByChain,
      hitPageLimit
    };
    
  } catch (error) {
    logger.error(`Error fetching messages: ${error.message}`);
    throw error;
  }
}

// Main function
async function main() {
  try {
    logger.info(`Checking cross-chain messages for date: ${formattedDate}`);
    const result = await fetchMessagesForDate(targetDate);
    
    if (result.hitPageLimit) {
      logger.warn('Note: Hit page limit, so counts may be incomplete');
    }
    
    logger.info(`Complete! Found ${result.totalMessages} cross-chain messages for ${formattedDate}`);
    
  } catch (error) {
    logger.error(`Script failed: ${error.message}`);
    process.exit(1);
  }
}

// Run the script
main(); 