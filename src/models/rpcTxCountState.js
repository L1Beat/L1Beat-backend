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
  // Live counting: last block counted (and its timestamp, for the next block's
  // rate), the UTC day it falls in and that day's running totals. Unset until
  // the first run finds yesterday's first block.
  lastBlock: Number,
  lastTimestamp: Number,
  dayTimestamp: Number,
  day: mongoose.Schema.Types.Mixed,
  // Older days, counted newest first after live counting is caught up:
  // { day, floor, endBlock, startBlock?, nextBlock?, prevTimestamp?, totals? }.
  // Null once every day back to `floor` is written.
  backfill: mongoose.Schema.Types.Mixed,
  // How receipts are fetched for fees: 'block', 'tx', or 'none' if the RPC
  // returns neither.
  feeSource: String,
  lastError: String,
  lastRunAt: Date
});

module.exports = mongoose.model('RpcTxCountState', rpcTxCountStateSchema);
