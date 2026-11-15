const axios = require('axios');
const zlib = require('zlib');
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
// Grayscale's fund page sits behind a bot checkpoint; the daily performance
// spreadsheet it links to is served straight from S3. The "-33" file holds
// the recent history only, so it stays small.
const GRAYSCALE_GAVA_XLSX = 'https://reporting-prod-20231113144948145500000003.s3.amazonaws.com/'
  + 'product-performance/55163830-f3e3-44e3-a08e-51e76499b731-33.xlsx';
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


// ---------- Minimal .xlsx reading (a zip of XML files) ----------

// The files in a zip archive, by name. Handles stored and deflated entries,
// which is all spreadsheet writers use.
function unzip(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buffer.readUInt16LE(p + 10);
    const size = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function xmlText(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Rows of a worksheet (1-based index) as arrays of cell strings.
function xlsxRows(buffer, sheet) {
  const files = unzip(buffer);
  const shared = [...String(files['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => xmlText([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const xml = files[`xl/worksheets/sheet${sheet}.xml`];
  if (!xml) throw new Error(`no sheet ${sheet}`);
  return [...String(xml).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(row =>
    [...row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attrs, body = '']) => {
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (/t="s"/.test(attrs)) return v === undefined ? '' : shared[Number(v)] ?? '';
      if (/t="inlineStr"/.test(attrs)) return xmlText(body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '');
      return v === undefined ? '' : xmlText(v);
    })
  );
}

// Header row + data rows → objects keyed by header.
function rowsToObjects(rows) {
  const [header = [], ...data] = rows;
  return data.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
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

  // Sheet 1: one row per day (shares outstanding, NAV, AUM). Sheet 3: AVAX per
  // share for the latest day. AVAX held = shares outstanding x AVAX per share.
  async grayscale() {
    const buffer = Buffer.from(await get(GRAYSCALE_GAVA_XLSX, { responseType: 'arraybuffer' }));
    const days = rowsToObjects(xlsxRows(buffer, 1)).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.Date || ''));
    const perShare = rowsToObjects(xlsxRows(buffer, 3)).find(r => /avax/i.test(r.Name || ''));
    if (!perShare) throw new Error('no AVAX per share row');
    // Use the day the AVAX per share is for, so both figures match.
    const day = days.find(r => r.Date === perShare.Date);
    if (!day) throw new Error(`no daily row for ${perShare.Date}`);
    const shares = parseNumber(day['Shares Outstanding']);
    const avaxPerShare = parseNumber(perShare['Asset/Share']);
    return {
      avax_held: shares !== null && avaxPerShare !== null ? shares * avaxPerShare : null,
      aum_usd: parseNumber(day.AUM),
      nav_per_share: parseNumber(day['NAV Per Share']),
      as_of: perShare.Date,
      source_url: 'https://etfs.grayscale.com/gava'
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
