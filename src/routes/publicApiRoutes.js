// Public, versioned API: /api/v1/*.
//
// The response shape is a contract for outside users: fields are picked
// explicitly, so a change to the internal /api/* routes can't leak in. Add
// fields freely; renaming or removing one needs a /api/v2.
//
// The schemas below define both the fields each response carries and the
// OpenAPI spec served at /api/v1/openapi.json, so the two can't drift.
//
// Read-only public data, so any website may call it from the browser.

const express = require('express');
const cors = require('cors');
const treasuryService = require('../services/treasuryService');
const cacheManager = require('../utils/cacheManager');
const logger = require('../utils/logger');

const router = express.Router();

const TTL = 60 * 1000;

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const nullable = schema => ({ ...schema, nullable: true });

const HOLDER_SCHEMA = {
  id: str('Stable holder identifier.', { example: 'vaneck-vavx' }),
  name: str('Holder name.'),
  ticker: str('Stock ticker.'),
  exchange: str('Listing exchange.'),
  kind: str('Company treasury or spot ETF.', { enum: ['treasury', 'etf'] }),
  sponsor: nullable(str('ETF sponsor. Null for companies.')),
  avax_held: nullable(num('AVAX held, in AVAX. For DeFi Technologies this is an estimate from its latest quarterly report: AVAX held directly plus its Fund A stake, minus the AVAX backing its Valour ETPs.')),
  aum_usd: nullable(num('Fund assets as reported by the fund, in USD. Null for companies.')),
  nav_per_share: nullable(num('Net asset value per share, in USD.')),
  staking_pct: nullable(num('Share of the fund\'s AVAX that is staked, in percent (0-100).')),
  staking_max_pct: nullable(num('Most of its AVAX the fund may stake, in percent (0-100).')),
  sponsor_fee_pct: nullable(num('Annual sponsor fee, in percent.')),
  as_of: nullable(str('Date the figure is valid for, as given by the source (UTC). For a report, its reporting date; for CoinGecko, the day it was read.', { format: 'date' })),
  source: str('"live": read automatically from the fund or CoinGecko every 6 hours. "manual": entered from the holder\'s latest report.', { enum: ['live', 'manual'] }),
  source_url: nullable(str('Where the figure comes from.', { format: 'uri' })),
  website_url: nullable(str('Holder\'s website.', { format: 'uri' }))
};

const TOTALS_SCHEMA = {
  treasury_avax: num('AVAX held by all company treasuries, in AVAX.'),
  etf_avax: num('AVAX held by all ETFs, in AVAX.'),
  combined_avax: num('AVAX held by all holders, in AVAX.'),
  treasury_count: { type: 'integer', description: 'Company treasuries with a figure.' },
  etf_count: { type: 'integer', description: 'ETFs with a figure.' },
  avax_price_usd: nullable(num('AVAX price, in USD.')),
  circulating_supply_avax: nullable(num('Circulating AVAX supply, in AVAX.')),
  circulating_supply_source: nullable(str('Source of the circulating supply.', { enum: ['coingecko'] })),
  market_as_of: nullable(str('Time the price and supply are for (UTC).', { format: 'date-time' })),
  combined_usd: nullable(num('combined_avax at avax_price_usd, in USD.')),
  combined_share_of_circulating_percent: nullable(num('combined_avax as a share of the circulating supply, in percent (0-100).'))
};

const TREASURIES_SCHEMA = {
  holders: {
    type: 'array',
    description: 'Companies and ETFs holding AVAX, in a fixed order.',
    items: { $ref: '#/components/schemas/TreasuryHolder' }
  },
  totals: { $ref: '#/components/schemas/TreasuryTotals' },
  updated_at: nullable(str('Time of the latest update (UTC).', { format: 'date-time' }))
};

const object = properties => ({
  type: 'object',
  required: Object.keys(properties),
  properties
});

const errorResponse = description => ({
  description,
  content: { 'application/json': { schema: object({ error: str('Error message.') }) } }
});

const OPENAPI = {
  openapi: '3.0.3',
  info: {
    title: 'L1Beat API',
    version: '1.0.0',
    description: 'AVAX held by public companies and spot ETFs. Unknown values are null, never 0.'
  },
  servers: [{ url: 'https://api.l1beat.io' }],
  paths: {
    '/api/v1/treasuries': {
      get: {
        operationId: 'getTreasuries',
        summary: 'AVAX held by companies and ETFs',
        description: 'Each holder\'s AVAX, with totals, the AVAX price and the circulating supply. Cached for 60 seconds.',
        tags: ['Treasuries'],
        responses: {
          200: {
            description: 'Holders and totals.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Treasuries' } } }
          },
          429: errorResponse('Rate limit exceeded: 1000 requests per 15 minutes per IP.'),
          500: errorResponse('The data could not be loaded.')
        }
      }
    }
  },
  components: {
    schemas: {
      Treasuries: object(TREASURIES_SCHEMA),
      TreasuryHolder: object(HOLDER_SCHEMA),
      TreasuryTotals: object(TOTALS_SCHEMA)
    }
  }
};

const pick = (obj, schema) => Object.fromEntries(Object.keys(schema).map(f => [f, obj?.[f] ?? null]));

router.use(cors({ origin: '*', methods: ['GET'], maxAge: 86400 }));
router.use((req, res, next) => {
  // helmet defaults this to same-origin; this data is meant to be fetched cross-origin.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

router.get('/openapi.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(OPENAPI);
});

// Companies and ETFs holding AVAX, with totals, the AVAX price and the
// circulating supply.
router.get('/treasuries', async (req, res) => {
  try {
    let body = cacheManager.get('v1:treasuries');
    if (!body) {
      const latest = await treasuryService.getLatest();
      body = {
        holders: latest.holders.map(h => pick(h, HOLDER_SCHEMA)),
        totals: pick(latest.totals, TOTALS_SCHEMA),
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
module.exports.OPENAPI = OPENAPI;
