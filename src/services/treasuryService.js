const axios = require('axios');
const { holders } = require('../config/treasuries');
const TreasurySnapshot = require('../models/treasurySnapshot');
const AvaxMarket = require('../models/avaxMarket');
const logger = require('../utils/logger');

// AVAX held by public companies and ETFs (config/treasuries.js). Each update
// writes one snapshot per holder for the current UTC day: live sources are
// fetched, manual holders take their config figures, and a holder whose live
// fetch fails keeps its last good figure. A figure is never replaced by 0.

const REQUEST_TIMEOUT_MS = 15000;
const HEADERS = { 'User-Agent': 'l1beat-backend' };

const VANECK_URL = 'https://www.vaneck.com/Main/FundDatasetBlock/Get/?blockId=353069&pageId=353872&ticker=VAVX';
const BITWISE_URL = 'https://bavaetf.com/';
const COINGECKO_TREASURY_URL = 'https://api.coingecko.com/api/v3/companies/public_treasury/avalanche-2';
const COINGECKO_COIN_URL = 'https://api.coingecko.com/api/v3/coins/avalanche-2'
  + '?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false';

function utcDate(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

// GET with a few retries for transient network and TLS errors.
async function get(url, options = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await axios.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: HEADERS, ...options })).data;
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

// "2,075,545", "$17.38", "0.20%" → number; null if not a finite number.
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = parseFloat(value.replace(/[$,%\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

// "$17.38M" → 17380000.
function parseCompactUsd(value) {
  const match = typeof value === 'string' && value.trim().match(/^\$?\s*([\d,.]+)\s*([KMB])?$/i);
  if (!match) return parseNumber(value);
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[(match[2] || '').toUpperCase()] || 1;
  return parseFloat(match[1].replace(/,/g, '')) * scale;
}

function ratioToPct(value) {
  const parsed = parseNumber(value);
  return parsed === null ? null : parsed * 100;
}

const fetchers = {
  async vaneck() {
    const data = await get(VANECK_URL);
    const list = data?.HoldingsList?.[0];
    const avax = list?.Holdings?.find(h => /avax/i.test(h?.HoldingName || ''));
    return {
      avax_held: parseNumber(avax?.Shares),
      aum_usd: parseCompactUsd(data?.['Total Net Assets']),
      nav_per_share: parseNumber(data?.NAV),
      sponsor_fee_pct: parseNumber(data?.['Expense Ratio']),
      staking_pct: parseNumber(data?.['Percentage Staked']),
      as_of: (list?.AsOfDate || avax?.AsOfDate || '').slice(0, 10) || null,
      source_url: 'https://www.vaneck.com/us/en/investments/avalanche-etf-vavx/'
    };
  },

  // The fund page is a Next.js app; its data is in the __NEXT_DATA__ script.
  async bitwise() {
    const html = await get(BITWISE_URL, { responseType: 'text' });
    const match = String(html).match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) throw new Error('no __NEXT_DATA__ on the page');
    const data = JSON.parse(match[1])?.props?.pageProps?.fundData?.data;
    const avax = data?.holdings?.basket?.find(h => /avalanche|avax/i.test(h?.companyName || ''));
    const staking = data?.fundDetails?.stakingMetrics;
    return {
      avax_held: parseNumber(avax?.shares),
      aum_usd: parseNumber(data?.fundDetails?.netAssets),
      nav_per_share: parseNumber(data?.navAndMarketPrice?.nav),
      staking_pct: ratioToPct(staking?.currentPercentageOfAssetsStaked),
      staking_max_pct: ratioToPct(staking?.targetPercentageOfAssetsStaked),
      as_of: data?.holdings?.asOfDate || data?.fundDetails?.asOfDate || null,
      source_url: BITWISE_URL
    };
  },

  // CoinGecko gives no date for the figure, so as_of is the day it was read.
  async 'coingecko-treasury'() {
    const data = await get(COINGECKO_TREASURY_URL);
    const company = data?.companies?.find(c => c?.name === 'AVAX One');
    return {
      avax_held: parseNumber(company?.total_holdings),
      aum_usd: null,
      as_of: utcDate(),
      source_url: 'https://www.coingecko.com/en/treasuries/avalanche'
    };
  }
};

// Today's figures for one holder, or null if there are none to write.
async function currentFigures(holder) {
  if (holder.manual) {
    return { ...holder.manual, source: 'manual' };
  }

  try {
    const figures = await fetchers[holder.live]();
    if (!(figures.avax_held > 0)) {
      throw new Error(`avax_held is ${figures.avax_held}`);
    }
    return { ...figures, source: 'live' };
  } catch (error) {
    const last = await TreasurySnapshot.findOne({ holderId: holder.id }).sort({ date: -1 }).lean();
    logger.warn(`[Treasuries] ${holder.id} fetch failed; ${last ? `keeping ${last.as_of}` : 'no earlier figure'}`, {
      error: error.message
    });
    if (!last) return null;
    const { _id, __v, holderId, date, lastUpdated, ...figures } = last;
    return figures;
  }
}

async function updateMarket(date) {
  try {
    const market = (await get(COINGECKO_COIN_URL))?.market_data;
    const price = parseNumber(market?.current_price?.usd);
    const supply = parseNumber(market?.circulating_supply);
    if (!(price > 0) || !(supply > 0)) {
      throw new Error(`price ${price}, circulating supply ${supply}`);
    }
    await AvaxMarket.updateOne(
      { date },
      { price_usd: price, circulating_supply: supply, as_of: market.last_updated, lastUpdated: new Date() },
      { upsert: true }
    );
  } catch (error) {
    logger.warn('[Treasuries] AVAX price/supply fetch failed; keeping the last figures', { error: error.message });
  }
}

async function updateAll() {
  const date = utcDate();
  let written = 0;

  await updateMarket(date);
  for (const holder of holders) {
    const figures = await currentFigures(holder);
    if (!figures) continue;
    await TreasurySnapshot.updateOne(
      { holderId: holder.id, date },
      { ...figures, lastUpdated: new Date() },
      { upsert: true }
    );
    written++;
  }

  logger.info(`[Treasuries] Wrote ${written} of ${holders.length} holders for ${date}`);
}

const sum = values => values.reduce((total, v) => total + v, 0);

async function getLatest() {
  const [snapshots, market] = await Promise.all([
    Promise.all(holders.map(h => TreasurySnapshot.findOne({ holderId: h.id }).sort({ date: -1 }).lean())),
    AvaxMarket.findOne().sort({ date: -1 }).lean()
  ]);

  const rows = holders.map((holder, i) => {
    const s = snapshots[i] || {};
    return {
      id: holder.id,
      name: holder.name,
      ticker: holder.ticker,
      exchange: holder.exchange,
      kind: holder.kind,
      sponsor: holder.sponsor ?? null,
      avax_held: s.avax_held ?? null,
      aum_usd: s.aum_usd ?? null,
      nav_per_share: s.nav_per_share ?? null,
      sponsor_fee_pct: s.sponsor_fee_pct ?? holder.sponsor_fee_pct ?? null,
      staking_pct: s.staking_pct ?? null,
      staking_max_pct: s.staking_max_pct ?? holder.staking_max_pct ?? null,
      as_of: s.as_of ?? null,
      source: s.source ?? (holder.manual ? 'manual' : 'live'),
      source_url: s.source_url ?? null,
      website_url: holder.website_url
    };
  });

  const held = kind => rows.filter(r => r.kind === kind && r.avax_held !== null);
  const treasuryAvax = sum(held('treasury').map(r => r.avax_held));
  const etfAvax = sum(held('etf').map(r => r.avax_held));
  const combined = treasuryAvax + etfAvax;
  const price = market?.price_usd ?? null;
  const supply = market?.circulating_supply ?? null;
  const updated = snapshots.filter(Boolean).map(s => new Date(s.lastUpdated).getTime());

  return {
    holders: rows,
    totals: {
      treasury_avax: treasuryAvax,
      etf_avax: etfAvax,
      combined_avax: combined,
      treasury_count: held('treasury').length,
      etf_count: held('etf').length,
      avax_price_usd: price,
      circulating_supply_avax: supply,
      circulating_supply_source: supply === null ? null : 'coingecko',
      market_as_of: market?.as_of ?? null,
      combined_usd: price === null ? null : combined * price,
      combined_share_of_circulating_percent: supply === null ? null : (combined / supply) * 100
    },
    updated_at: updated.length ? new Date(Math.max(...updated)).toISOString() : null
  };
}

// Daily snapshots per holder for the last `days` UTC days, newest first.
async function getHistory(days) {
  const from = utcDate(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const snapshots = await TreasurySnapshot.find({ date: { $gte: from } })
    .sort({ date: -1 })
    .select('holderId date avax_held aum_usd')
    .lean();

  return holders.map(holder => ({
    id: holder.id,
    name: holder.name,
    kind: holder.kind,
    history: snapshots
      .filter(s => s.holderId === holder.id)
      .map(s => ({ date: s.date, avax_held: s.avax_held, aum_usd: s.aum_usd ?? null }))
  }));
}

module.exports = {
  updateAll,
  getLatest,
  getHistory,
  // Exported for tests.
  parseNumber,
  parseCompactUsd
};
