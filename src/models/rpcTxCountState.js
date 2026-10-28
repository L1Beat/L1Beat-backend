const mongoose = require('mongoose');

// Per-chain progress of rpcMetricsService (named for its first metric,
// txCount). A row exists while the metrics API returns 404 for the chain; it
// records how far the chain's blocks have been counted so each run only walks
// new blocks.
const rpcTxCountStateSchema = new mongoose.Schema({
  chainId: {
    type: String,
    required: true,
    unique: true
  },
  // rpcMetricsService's STATE_VERSION when this was saved.
  version: Number,
  // Last block counted (and its timestamp, for the next block's rate), the UTC
  // day it falls in and that day's running totals. Unset until the first run
  // finds the backfill start block.
  lastBlock: Number,
  lastTimestamp: Number,
  dayTimestamp: Number,
  day: mongoose.Schema.Types.Mixed,
  // How receipts are fetched for fees: 'block', 'tx', or 'none' if the RPC
  // returns neither.
  feeSource: String,
  lastError: String,
  lastRunAt: Date
});

module.exports = mongoose.model('RpcTxCountState', rpcTxCountStateSchema);
