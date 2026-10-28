const mongoose = require('mongoose');

// Per-chain progress of rpcTxCountService. A row exists while the metrics API
// returns 404 for the chain; it records how far the chain's blocks have been
// counted so each run only walks new blocks.
const rpcTxCountStateSchema = new mongoose.Schema({
  chainId: {
    type: String,
    required: true,
    unique: true
  },
  // Last block counted, and the running count of the UTC day it falls in.
  // Unset until the first run finds the backfill start block.
  lastBlock: Number,
  dayTimestamp: Number,
  dayCount: Number,
  lastError: String,
  lastRunAt: Date
});

module.exports = mongoose.model('RpcTxCountState', rpcTxCountStateSchema);
