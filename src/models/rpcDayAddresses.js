const mongoose = require('mongoose');

// Addresses rpcMetricsService has seen so far on a UTC day it is still
// counting, so a day's active addresses can be counted across several runs.
// Each run appends the addresses that are new since its last save as another
// row: `addresses` is 20-byte addresses back to back. A day's rows are deleted
// once the day is written.
const rpcDayAddressesSchema = new mongoose.Schema({
  chainId: {
    type: String,
    required: true
  },
  day: {
    type: Number,
    required: true
  },
  addresses: {
    type: Buffer,
    required: true
  }
});

rpcDayAddressesSchema.index({ chainId: 1, day: 1 });

module.exports = mongoose.model('RpcDayAddresses', rpcDayAddressesSchema);
