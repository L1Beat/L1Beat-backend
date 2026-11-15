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
      // Reported holdings at 2026-09-30 from the Q3 2026 results (8-K filed
      // 2026-11-05): ~13.31M AVAX (~7.93M unlocked, ~5.38M locked; ~91%
      // staked). Replace with the Q4 figure once it's out.
      avax_held: 13310000,
      aum_usd: null,
      as_of: '2026-09-30',
      source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=2092446&type=8-K'
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
      // Our estimate of DEFT's own AVAX at 2026-09-30, from the Q3 2026
      // interim statements (6-K filed 2026-11-12). Not a reported figure:
      //   AVAX held directly (note 6)             789,739.5
      //   less AVAX owed to Valour ETP holders   -715,480  ($7,764,176 in
      //     note 14, at the note 6 implied price of $10.8517)
      //   plus AVAX in the Fund A stake (note 7)  386,174.2
      //   = 460,434, rounded to 460,000 as it's an estimate.
      // Replace with the Q4 2026 figures (6-K expected Feb-Mar 2027).
      avax_held: 460000,
      aum_usd: null,
      as_of: '2026-09-30',
      source_url: 'https://www.sec.gov/Archives/edgar/data/1888274/000149315226051470/ex99-1.htm'
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
    live: 'grayscale'
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
