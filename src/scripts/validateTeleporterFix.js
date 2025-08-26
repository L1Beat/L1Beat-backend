/**
 * Script to validate the teleporter data fix
 * This script will:
 * 1. Force a teleporter data update
 * 2. Fetch the data from the API
 * 3. Compare with direct API results
 * 
 * Usage: node src/scripts/validateTeleporterFix.js
 */

require('dotenv').config();

const axios = require('axios');
const teleporterService = require('../services/teleporterService');
const logger = require('../utils/logger');
const TeleporterMessage = require('../models/teleporterMessage').TeleporterMessage;

// Add console logging
function log(message, data = {}) {
  logger.info(message, data);
  console.log(message, data ? JSON.stringify(data) : '');
}

function logError(message, error) {
  logger.error(message, error);
  console.error(message, error ? JSON.stringify(error) : '');
}

/**
 * Run the validation test
 */
async function validateFix() {
  try {
    log('=== TELEPORTER DATA FIX VALIDATION ===');
    
    // 1. Force a teleporter data update
    log('1. Forcing teleporter data update...');
    
    // Generate a unique request ID
    const requestId = `validate-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    
    // Call the service method
    const updateResult = await teleporterService.updateTeleporterData(requestId);
    
    log('Update completed:', {
      success: updateResult.success,
      messageCount: updateResult.messageCount,
      totalMessages: updateResult.totalMessages
    });
    
    // 2. Fetch the latest data from the database
    log('2. Fetching latest data from the database...');
    
    const dbData = await TeleporterMessage.findOne({ dataType: 'daily' }).sort({ updatedAt: -1 });
    
    if (!dbData) {
      logError('No data found in the database!');
      process.exit(1);
    }
    
    log('Database data:', {
      updatedAt: dbData.updatedAt,
      pairCount: dbData.messageCounts.length,
      totalMessages: dbData.totalMessages,
      dataType: dbData.dataType,
      timeWindow: dbData.timeWindow
    });
    
    // Count the total from individual message counts
    const dbTotalFromCounts = dbData.messageCounts.reduce((sum, item) => sum + item.messageCount, 0);
    
    log('Validation check:', {
      storedTotalMessages: dbData.totalMessages,
      calculatedFromCounts: dbTotalFromCounts,
      difference: dbData.totalMessages - dbTotalFromCounts,
      match: dbData.totalMessages === dbTotalFromCounts
    });
    
    // 3. Fetch from the API endpoint
    log('3. Fetching data from the API endpoint...');
    
    // Make a request to the API endpoint
    try {
      const apiResponse = await axios.get('http://localhost:5001/api/teleporter/messages/daily-count');
      
      log('API response:', {
        status: apiResponse.status,
        pairCount: apiResponse.data.data.length,
        totalMessages: apiResponse.data.metadata.totalMessages,
        updatedAt: apiResponse.data.metadata.updatedAt
      });
      
      // Count the total from individual message counts
      const apiTotalFromCounts = apiResponse.data.data.reduce((sum, item) => sum + item.messageCount, 0);
      
      log('API validation check:', {
        storedTotalMessages: apiResponse.data.metadata.totalMessages,
        calculatedFromCounts: apiTotalFromCounts,
        difference: apiResponse.data.metadata.totalMessages - apiTotalFromCounts,
        match: apiResponse.data.metadata.totalMessages === apiTotalFromCounts
      });
      
      // Compare DB data with API data
      log('Comparing DB data with API data:', {
        dbTotal: dbData.totalMessages,
        apiTotal: apiResponse.data.metadata.totalMessages,
        match: dbData.totalMessages === apiResponse.data.metadata.totalMessages
      });
      
    } catch (apiError) {
      logError('Error fetching API data:', {
        message: apiError.message
      });
    }
    
    log('=== VALIDATION COMPLETE ===');
    process.exit(0);
    
  } catch (error) {
    logError('Error during validation:', {
      message: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Run the validation
validateFix(); 