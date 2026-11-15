// Public, versioned API: /api/v1/*.
//
// The response shape is a contract for outside users: fields are picked
// explicitly, so a change to the internal /api/* routes can't leak in. Add
// fields freely; renaming or removing one needs a /api/v2.
//
// Read-only public data, so any website may call it from the browser.

const express = require('express');
const cors = require('cors');
const treasuryService = require('../services/treasuryService');
const cacheManager = require('../utils/cacheManager');
const logger = require('../utils/logger');

const router = express.Router();

const TTL = 60 * 1000;

const HOLDER_FIELDS = [
  'id', 'name', 'ticker', 'exchange', 'kind', 'sponsor',
  'avax_held', 'aum_usd', 'nav_per_share',
  'staking_pct', 'staking_max_pct', 'sponsor_fee_pct',
  'as_of', 'source', 'source_url', 'website_url'
];
const TOTAL_FIELDS = [
  'treasury_avax', 'etf_avax', 'combined_avax', 'treasury_count', 'etf_count',
  'avax_price_usd', 'circulating_supply_avax', 'circulating_supply_source', 'market_as_of',
  'combined_usd', 'combined_share_of_circulating_percent'
];

const pick = (obj, fields) => Object.fromEntries(fields.map(f => [f, obj?.[f] ?? null]));

router.use(cors({ origin: '*', methods: ['GET'], maxAge: 86400 }));
router.use((req, res, next) => {
  // helmet defaults this to same-origin; this data is meant to be fetched cross-origin.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// Companies and ETFs holding AVAX, with totals, the AVAX price and the
// circulating supply.
router.get('/treasuries', async (req, res) => {
  try {
    let body = cacheManager.get('v1:treasuries');
    if (!body) {
      const latest = await treasuryService.getLatest();
      body = {
        holders: latest.holders.map(h => pick(h, HOLDER_FIELDS)),
        totals: pick(latest.totals, TOTAL_FIELDS),
        updated_at: latest.updated_at ?? null
      };
      cacheManager.set('v1:treasuries', body, TTL);
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json(body);
  } catch (error) {
    logger.error('v1 Treasuries Error:', { error: error.message });
    res.status(500).json({ error: 'Failed to load treasuries' });
  }
});

module.exports = router;
