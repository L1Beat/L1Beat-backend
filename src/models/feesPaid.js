const mongoose = require('mongoose');

const feesPaidSchema = new mongoose.Schema({
  chainId: {
    type: String,
    required: true
  },
  timestamp: {
    type: Number,
    required: true
  },
  value: {
    type: Number,
    required: true
  },
  // 'rpc' for rows counted from the chain's own RPC (rpcMetricsService).
  source: String,
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

// Compound index for efficient queries
feesPaidSchema.index({ chainId: 1, timestamp: 1 }, { unique: true });

module.exports = mongoose.model('FeesPaid', feesPaidSchema);
