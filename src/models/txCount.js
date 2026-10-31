const mongoose = require('mongoose');

const txCountSchema = new mongoose.Schema({
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
  // Unset for rows from the metrics API; 'rpc' for rows counted from the
  // chain's own RPC (rpcMetricsService) when the metrics API lacks the chain.
  source: String,
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

// Compound index for efficient queries
txCountSchema.index({ chainId: 1, timestamp: 1 }, { unique: true });

module.exports = mongoose.model('TxCount', txCountSchema);
