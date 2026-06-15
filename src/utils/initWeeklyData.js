require('dotenv').config();
const mongoose = require('mongoose');
const { TeleporterUpdateState } = require('../models/teleporterMessage');
const teleporterService = require('../services/teleporterService');
const logger = require('../utils/logger');

async function initWeeklyData() {
  try {
    // Connect to the database
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.DEV_MONGODB_URI || process.env.PROD_MONGODB_URI);
    console.log('Connected to MongoDB');

    // Check if there's already an update in progress
    const existingUpdate = await TeleporterUpdateState.findOne({ 
      updateType: 'weekly',
      state: 'in_progress'
    });
    
    if (existingUpdate) {
      console.log('Weekly update already in progress:', {
        startedAt: existingUpdate.startedAt,
        lastUpdatedAt: existingUpdate.lastUpdatedAt,
        progress: existingUpdate.progress
      });
      
      // Check if it's stale
      const lastUpdated = new Date(existingUpdate.lastUpdatedAt);
      const timeSinceUpdate = new Date().getTime() - lastUpdated.getTime();
      
      if (timeSinceUpdate > 5 * 60 * 1000) { // 5 minutes
        console.log('Found stale update, resetting it...');
        
        existingUpdate.state = 'failed';
        existingUpdate.lastUpdatedAt = new Date();
        existingUpdate.error = {
          message: 'Update timed out',
          details: `No updates for ${Math.round(timeSinceUpdate / 1000 / 60)} minutes`
        };
        await existingUpdate.save();
        
        console.log('Stale update marked as failed, starting new update...');
      } else {
        console.log('Update is still active, not starting a new one');
        return;
      }
    }

    // Start the resumable weekly data update (fetches the 7 day-windows).
    console.log('Starting weekly teleporter data update...');
    const result = await teleporterService.updateWeeklyData();
    
    console.log('Weekly data update completed:', {
      success: result.success,
      messageCount: result.messageCount,
      totalMessages: result.totalMessages
    });
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Disconnect from the database when done
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run the function
initWeeklyData(); 