// Public companies (treasuries) and ETFs holding AVAX, for GET /api/treasuries.
//
// Holders with a `live` source are refreshed by treasuryService; the other
// fields here are their fixed details. `manual` holds figures with no live
// source: update them by hand from the holder's latest filing, keeping
// `as_of` (the date the figure is valid for) and `source_url` in step.

const holders = [
  {
    id: 'avax-one',
    name: 'AVAX One',
    ticker: 'AVX',
    exchange: 'NASDAQ',
    kind: 'treasury',
    website_url: 'https://avax-one.com',
    live: 'coingecko-treasury'
  },
  {
    id: 'avat',
    name: 'Avalanche Treasury Co.',
    ticker: 'AVAT',
    exchange: 'NASDAQ', // Listed 2026-06-11 after the merger with MLAC
    kind: 'treasury',
    website_url: 'https://avat.com',
    manual: {
      // 15,312,363 AVAX at 2026-06-30 (Q2 results), less 2,082,371.6 AVAX
      // sold to Avalanche (BVI), Inc. on 2026-09-23. Not a reported total:
      // replace with the Q3 figure once it's out.
      avax_held: 13229991,
      aum_usd: null,
      as_of: '2026-09-23',
      source_url: 'https://www.businesswire.com/news/home/20260826221979/en/Avalanche-Treasury-Company-Reports-Second-Quarter-2026-Financial-Results'
    }
  },
  {
    id: 'deft',
    name: 'DeFi Technologies',
    ticker: 'DEFT',
    exchange: 'NASDAQ',
    kind: 'treasury',
    website_url: 'https://defi.tech',
    manual: {
      // The purchase disclosed in Aug 2025. Later quarterly reports give only
      // the treasury's total value, not its AVAX count.
      avax_held: 398321,
      aum_usd: null,
      as_of: '2025-08-06',
      source_url: 'https://defillama.com/digital-asset-treasury/deft'
    }
  },
  {
    id: 'vaneck-vavx',
    name: 'VanEck Avalanche ETF',
    ticker: 'VAVX',
    exchange: 'NASDAQ',
    kind: 'etf',
    sponsor: 'VanEck',
    staking_max_pct: 85,
    website_url: 'https://www.vaneck.com/us/en/investments/avalanche-etf-vavx/',
    live: 'vaneck'
  },
  {
    id: 'grayscale-gava',
    name: 'Grayscale Avalanche Staking ETF',
    ticker: 'GAVA',
    exchange: 'NASDAQ',
    kind: 'etf',
    sponsor: 'Grayscale',
    sponsor_fee_pct: 0.35, // After the waiver that ended 2026-06-12
    staking_max_pct: 85,
    website_url: 'https://etfs.grayscale.com/gava',
    manual: {
      // Q2 10-Q: 649,890.87 AVAX, $4.27M at fair value.
      avax_held: 649890.87,
      aum_usd: 4270000,
      as_of: '2026-06-30',
      source_url: 'https://www.sec.gov/Archives/edgar/data/2035053/000203505326000023/ck0002035053-20260630.htm'
    }
  },
  {
    id: 'bitwise-bava',
    name: 'Bitwise Avalanche ETF',
    ticker: 'BAVA',
    exchange: 'NYSE Arca',
    kind: 'etf',
    sponsor: 'Bitwise',
    sponsor_fee_pct: 0.34,
    website_url: 'https://bavaetf.com',
    live: 'bitwise'
  }
];

module.exports = { holders };
