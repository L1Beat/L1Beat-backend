const mongoose = require('mongoose');

/**
 * Schema for teleporter message counts between chains
 */
const teleporterMessageSchema = new mongoose.Schema({
    // Timestamp when the data was last updated
    updatedAt: {
        type: Date,
        default: Date.now,
        required: true
    },
    // Array of message counts between chains
    messageCounts: [{
        sourceChain: {
            type: String,
            required: true
        },
        destinationChain: {
            type: String,
            required: true
        },
        messageCount: {
            type: Number,
            required: true
        }
    }],
    // Total number of messages processed
    totalMessages: {
        type: Number,
        required: true
    },
    // Time window in hours that the data represents
    timeWindow: {
        type: Number,
        required: true,
        default: 24
    },
    // Type of data (daily or weekly)
    dataType: {
        type: String,
        enum: ['daily', 'weekly'],
        default: 'daily',
        required: true
    }
});

// Create a compound index for efficient querying
teleporterMessageSchema.index({ updatedAt: -1, dataType: 1 });

/**
 * Schema for tracking the state of weekly data updates
 */
const teleporterUpdateStateSchema = new mongoose.Schema({
    // Type of update (daily, weekly)
    updateType: {
        type: String,
        enum: ['daily', 'weekly'],
        required: true,
        unique: true,
        index: true
    },
    // Current state of the update
    state: {
        type: String,
        enum: ['in_progress', 'completed', 'failed'],
        required: true,
        default: 'in_progress'
    },
    // Timestamp when the update was started
    startedAt: {
        type: Date,
        required: true,
        default: Date.now
    },
    // Timestamp when the update was last updated
    lastUpdatedAt: {
        type: Date,
        required: true,
        default: Date.now
    },
    // Progress information
    progress: {
        currentDay: {
            type: Number,
            default: 1
        },
        totalDays: {
            type: Number,
            default: 7
        },
        daysCompleted: {
            type: Number,
            default: 0
        },
        currentChunk: {
            type: Number,
            default: 0
        },
        totalChunks: {
            type: Number,
            default: 6
        },
        messagesCollected: {
            type: Number,
            default: 0
        }
    },
    // Error information if the update failed
    error: {
        message: String,
        details: mongoose.Schema.Types.Mixed,
        timestamp: {
            type: Date,
            default: Date.now
        }
    },
    // Temporary storage for partial results
    partialResults: [{
        day: Number,
        messageCount: [{
            sourceChain: String,
            destinationChain: String,
            messageCount: Number
        }],
        totalMessages: Number,
        timeWindow: Number,
        startHoursAgo: Number,
        endHoursAgo: Number,
        processedAt: Date
    }]
});

// Create an index for efficient querying
teleporterUpdateStateSchema.index({ updateType: 1, state: 1 });

// Add a pre-save hook to ensure progress field is always properly initialized
teleporterUpdateStateSchema.pre('save', function(next) {
    // If progress is undefined or null, initialize it
    if (!this.progress) {
        this.progress = {
            currentDay: 1,
            totalDays: 7,
            daysCompleted: 0,
            currentChunk: 0,
            totalChunks: 6,
            messagesCollected: 0
        };
    }
    
    // Ensure all progress fields have values
    if (this.progress.currentDay === undefined) this.progress.currentDay = 1;
    if (this.progress.totalDays === undefined) this.progress.totalDays = 7;
    if (this.progress.daysCompleted === undefined) this.progress.daysCompleted = 0;
    if (this.progress.currentChunk === undefined) this.progress.currentChunk = 0;
    if (this.progress.totalChunks === undefined) this.progress.totalChunks = 6;
    if (this.progress.messagesCollected === undefined) this.progress.messagesCollected = 0;
    
    // If state is completed, ensure progress reflects completion
    if (this.state === 'completed' && this.updateType === 'weekly') {
        this.progress.currentDay = 8;
        this.progress.daysCompleted = 7;
    }
    
    next();
});

const TeleporterMessage = mongoose.model('TeleporterMessage', teleporterMessageSchema);
const TeleporterUpdateState = mongoose.model('TeleporterUpdateState', teleporterUpdateStateSchema);

module.exports = { 
    TeleporterMessage,
    TeleporterUpdateState
}; 