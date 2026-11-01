const mongoose = require('mongoose');

// AVAX price and circulating supply from CoinGecko, one row per UTC day,
// written by treasuryService alongside the treasury snapshots.
const avaxMarketSchema = new mongoose.Schema({
  // UTC day, 'YYYY-MM-DD'.
  date: {
    type: String,
    required: true,
    unique: true
  },
  price_usd: {
    type: Number,
    required: true
  },
  circulating_supply: {
    type: Number,
    required: true
  },
  // CoinGecko's last_updated for these figures.
  as_of: Date,
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('AvaxMarket', avaxMarketSchema);
