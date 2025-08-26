/**
 * Script to manually trigger the teleporter data update
 * 
 * Usage: node src/scripts/updateTeleporterData.js
 */

require('dotenv').config();

const teleporterService = require('../services/teleporterService');
const logger = require('../utils/logger');

async function main() {
    try {
        logger.info('Manually triggering teleporter data update...');
        
        // Generate a unique request ID
        const requestId = `manual-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        
        // Call the service method
        const result = await teleporterService.updateTeleporterData(requestId);
        
        logger.info('Update completed successfully:', result);
        process.exit(0);
    } catch (error) {
        logger.error('Error updating teleporter data:', {
            message: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
}

main(); 