/**
 * Update Teleporter Data
 *
 * Manually trigger a fresh update of teleporter message counts
 */

require('dotenv').config();
const mongoose = require('mongoose');
const teleporterService = require('../src/services/teleporterService');
const logger = require('../src/utils/logger');

async function main() {
  try {
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    logger.info('Connecting to database...');
    await mongoose.connect(dbUri);
    logger.info('Connected\n');

    // Clear cached chain mapping to force refresh
    logger.info('Clearing cached chain mapping...');
    teleporterService.chainMapping = null;
    teleporterService.chainMappingLastUpdate = null;

    // Update daily data
    logger.info('Updating daily teleporter data...');
    await teleporterService.updateDailyData();
    logger.info('✅ Daily data updated\n');

    // Update weekly data
    logger.info('Updating weekly teleporter data...');
    await teleporterService.updateWeeklyData();
    logger.info('✅ Weekly data updated\n');

    logger.info('All teleporter data updated successfully!');

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    logger.error('Error updating teleporter data:', error);
    process.exit(1);
  }
}

main();
