const mongoose = require('mongoose');

// One row per AVAX holder (config/treasuries.js) per UTC day, written by
// treasuryService. The latest row is the holder's current figure; a failed
// live fetch carries the last good figure forward with its original as_of.
const treasurySnapshotSchema = new mongoose.Schema({
  holderId: {
    type: String,
    required: true
  },
  // UTC day the row was written for, 'YYYY-MM-DD'.
  date: {
    type: String,
    required: true
  },
  avax_held: {
    type: Number,
    required: true
  },
  // The fund's own reported figure, or null when it reports none.
  aum_usd: Number,
  nav_per_share: Number,
  sponsor_fee_pct: Number,
  staking_pct: Number,
  staking_max_pct: Number,
  // Date the figure is valid for (from the source), not when it was fetched.
  as_of: String,
  source: {
    type: String,
    enum: ['live', 'manual'],
    required: true
  },
  source_url: String,
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

treasurySnapshotSchema.index({ holderId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('TreasurySnapshot', treasurySnapshotSchema);
