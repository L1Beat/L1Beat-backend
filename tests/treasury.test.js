/**
 * Unit tests for treasuryService: AVAX held by companies and ETFs. Live
 * sources are mocked axios responses; the models are in-memory stores.
 *
 * This file intentionally does NOT require ./setup; it needs no app or DB.
 */

jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../src/models/treasurySnapshot', () => ({ findOne: jest.fn(), find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/avaxMarket', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));

const zlib = require('zlib');
const axios = require('axios');
const TreasurySnapshot = require('../src/models/treasurySnapshot');
const AvaxMarket = require('../src/models/avaxMarket');
const treasuryService = require('../src/services/treasuryService');
const { holders } = require('../src/config/treasuries');

const TODAY = new Date().toISOString().slice(0, 10);

const VANECK = {
  NAV: '$17.38',
  'Total Net Assets': '$17.38M',
  'Expense Ratio': '0.20%',
  'Percentage Staked': '80.04',
  HoldingsList: [{ AsOfDate: '2026-10-29T00:00:00', Holdings: [{ HoldingName: 'Avax', Shares: '2,075,545' }] }]
};
const BITWISE_DATA = {
  fundDetails: {
    netAssets: 22377720.94,
    stakingMetrics: { currentPercentageOfAssetsStaked: 0.7002, targetPercentageOfAssetsStaked: 0.7 }
  },
  holdings: { asOfDate: '2026-10-30', basket: [{ companyName: 'AVALANCHE', shares: 2670358.45 }] },
  navAndMarketPrice: { nav: 24.06 }
};
const bitwisePage = data => '<html><script id="__NEXT_DATA__" type="application/json">'
  + JSON.stringify({ props: { pageProps: { fundData: { data } } } }) + '</script></html>';
// A minimal .xlsx: a zip (stored, not deflated) of the XML parts the service
// reads. Sheet 1 uses shared strings and sheet 3 inline strings, as the
// service handles both.
function zip(files) {
  const crc32 = buf => (typeof zlib.crc32 === 'function' ? zlib.crc32(buf) : 0);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}
const sheet = rows => `<worksheet><sheetData>${rows.map(r => `<row>${r}</row>`).join('')}</sheetData></worksheet>`;
const sharedCell = i => `<c t="s"><v>${i}</v></c>`;
const numCell = n => `<c><v>${n}</v></c>`;
const inlineCell = s => `<c t="inlineStr"><is><t>${s}</t></is></c>`;
const GRAYSCALE_STRINGS = ['Date', 'Shares Outstanding', 'NAV Per Share', 'AUM', '2026-11-12', '2026-11-13'];
const GRAYSCALE_XLSX = zip({
  'xl/sharedStrings.xml': `<sst>${GRAYSCALE_STRINGS.map(s => `<si><t>${s}</t></si>`).join('')}</sst>`,
  'xl/worksheets/sheet1.xml': sheet([
    [0, 1, 2, 3].map(sharedCell).join(''),
    sharedCell(4) + numCell(345000) + numCell(20.1) + numCell(6934500),
    sharedCell(5) + numCell(350000) + numCell(20.38) + numCell(7090818.79)
  ]),
  'xl/worksheets/sheet3.xml': sheet([
    ['Name', 'Date', 'Asset/Share'].map(inlineCell).join(''),
    inlineCell('AVAX') + inlineCell('2026-11-13') + numCell(2.4)
  ])
});
const COINGECKO_TREASURY ={ companies: [{ name: 'AVAX One', total_holdings: 13800000 }] };
const COINGECKO_COIN = {
  market_data: { current_price: { usd: 8.63 }, circulating_supply: 444064787.28, last_updated: '2026-11-01T19:02:50.000Z' }
};

// Routes axios.get by URL; `overrides` maps a URL fragment to data or an Error.
function sources(overrides = {}) {
  const responses = {
    vaneck: VANECK,
    bavaetf: bitwisePage(BITWISE_DATA),
    'product-performance': GRAYSCALE_XLSX,
    public_treasury: COINGECKO_TREASURY,
    'coins/avalanche-2': COINGECKO_COIN,
    ...overrides
  };
  axios.get.mockImplementation(async url => {
    const key = Object.keys(responses).find(k => url.includes(k));
    const data = responses[key];
    if (data instanceof Error) throw data;
    return { data };
  });
}

// In-memory TreasurySnapshot / AvaxMarket, keyed like their unique indexes.
let snapshots;
let markets;
const query = result => ({
  sort: () => query(result),
  select: () => query(result),
  lean: async () => result
});
function stores() {
  snapshots = new Map();
  markets = new Map();
  const latest = rows => rows.sort((a, b) => b.date.localeCompare(a.date))[0] || null;

  TreasurySnapshot.updateOne.mockImplementation(async ({ holderId, date }, fields) => {
    snapshots.set(`${holderId}:${date}`, { holderId, date, ...fields });
  });
  TreasurySnapshot.findOne.mockImplementation(({ holderId }) =>
    query(latest([...snapshots.values()].filter(s => s.holderId === holderId))));
  TreasurySnapshot.find.mockImplementation(({ date }) =>
    query([...snapshots.values()].filter(s => s.date >= date.$gte).sort((a, b) => b.date.localeCompare(a.date))));

  AvaxMarket.updateOne.mockImplementation(async ({ date }, fields) => {
    markets.set(date, { date, ...fields });
  });
  AvaxMarket.findOne.mockImplementation(() => query(latest([...markets.values()])));
}

const holder = (body, id) => body.holders.find(h => h.id === id);

beforeEach(() => {
  stores();
  // Skip the retry waits.
  jest.spyOn(global, 'setTimeout').mockImplementation(fn => { fn(); return 0; });
});

describe('treasuryService.updateAll + getLatest', () => {
  it('parses each live source and takes manual figures from the config', async () => {
    sources();
    await treasuryService.updateAll();
    const body = await treasuryService.getLatest();

    expect(body.holders.map(h => h.id)).toEqual(holders.map(h => h.id));
    expect(holder(body, 'vaneck-vavx')).toMatchObject({
      kind: 'etf',
      sponsor: 'VanEck',
      avax_held: 2075545,
      aum_usd: 17380000,
      nav_per_share: 17.38,
      sponsor_fee_pct: 0.2,
      staking_pct: 80.04,
      staking_max_pct: 85,
      as_of: '2026-10-29',
      source: 'live'
    });
    expect(holder(body, 'bitwise-bava')).toMatchObject({
      avax_held: 2670358.45,
      aum_usd: 22377720.94,
      nav_per_share: 24.06,
      sponsor_fee_pct: 0.34,
      staking_max_pct: 70,
      as_of: '2026-10-30',
      source: 'live'
    });
    expect(holder(body, 'bitwise-bava').staking_pct).toBeCloseTo(70.02);
    expect(holder(body, 'avax-one')).toMatchObject({ kind: 'treasury', avax_held: 13800000, as_of: TODAY, source: 'live' });

    // Shares outstanding x AVAX per share, both for the per-share row's day.
    expect(holder(body, 'grayscale-gava')).toMatchObject({
      kind: 'etf',
      sponsor: 'Grayscale',
      aum_usd: 7090818.79,
      nav_per_share: 20.38,
      as_of: '2026-11-13',
      source: 'live',
      source_url: 'https://etfs.grayscale.com/gava'
    });
    expect(holder(body, 'grayscale-gava').avax_held).toBeCloseTo(840000);

    // Manual holders take their figures from the config.
    const manual = holders.find(h => h.manual);
    expect(holder(body, manual.id)).toMatchObject({
      avax_held: manual.manual.avax_held,
      as_of: manual.manual.as_of,
      source: 'manual',
      source_url: manual.manual.source_url
    });
  });

  it('totals AVAX by kind and values it at the CoinGecko price', async () => {
    sources();
    await treasuryService.updateAll();
    const { holders: rows, totals } = await treasuryService.getLatest();

    const sumOf = kind => rows.filter(r => r.kind === kind).reduce((t, r) => t + r.avax_held, 0);
    expect(totals.treasury_avax).toBeCloseTo(sumOf('treasury'));
    expect(totals.etf_avax).toBeCloseTo(sumOf('etf'));
    expect(totals.combined_avax).toBeCloseTo(sumOf('treasury') + sumOf('etf'));
    expect(totals).toMatchObject({
      treasury_count: 3,
      etf_count: 3,
      avax_price_usd: 8.63,
      circulating_supply_avax: 444064787.28,
      circulating_supply_source: 'coingecko'
    });
    expect(totals.combined_usd).toBeCloseTo(totals.combined_avax * 8.63);
    expect(totals.combined_share_of_circulating_percent).toBeCloseTo(totals.combined_avax / 444064787.28 * 100);
  });

  it('keeps the last good figure when a live source fails, never 0', async () => {
    sources();
    await treasuryService.updateAll();
    // Move the rows to yesterday, then fail VanEck and return 0 from Bitwise.
    for (const [key, s] of [...snapshots]) {
      snapshots.delete(key);
      snapshots.set(`${s.holderId}:2026-01-01`, { ...s, date: '2026-01-01' });
    }
    sources({
      vaneck: new Error('Request failed with status code 503'),
      bavaetf: bitwisePage({ ...BITWISE_DATA, holdings: { basket: [{ companyName: 'AVALANCHE', shares: 0 }] } })
    });
    await treasuryService.updateAll();
    const body = await treasuryService.getLatest();

    expect(holder(body, 'vaneck-vavx')).toMatchObject({ avax_held: 2075545, as_of: '2026-10-29' });
    expect(holder(body, 'bitwise-bava')).toMatchObject({ avax_held: 2670358.45, as_of: '2026-10-30' });
    // Carried forward into today's row, so history has no gap.
    expect(snapshots.get(`vaneck-vavx:${TODAY}`)).toMatchObject({ avax_held: 2075545, as_of: '2026-10-29' });
  });

  it('returns null, not 0, for a live holder that has never been fetched', async () => {
    sources({ vaneck: new Error('timeout'), 'coins/avalanche-2': new Error('429') });
    await treasuryService.updateAll();
    const { holders: rows, totals } = await treasuryService.getLatest();

    expect(holder({ holders: rows }, 'vaneck-vavx')).toMatchObject({ avax_held: null, as_of: null });
    // Each failing source is tried 3 times.
    expect(axios.get.mock.calls.filter(([url]) => url.includes('vaneck'))).toHaveLength(3);
    // Bitwise and Grayscale still count; VanEck has no figure.
    expect(totals.etf_count).toBe(2);
    expect(totals).toMatchObject({ avax_price_usd: null, combined_usd: null, combined_share_of_circulating_percent: null });
  });
});

describe('treasuryService.getHistory', () => {
  it('returns each holder\'s daily rows, newest first', async () => {
    sources();
    await treasuryService.updateAll();
    snapshots.set('vaneck-vavx:2020-01-01', { holderId: 'vaneck-vavx', date: '2020-01-01', avax_held: 1 });
    const history = await treasuryService.getHistory(7);

    const vavx = history.find(h => h.id === 'vaneck-vavx');
    expect(vavx).toMatchObject({ name: 'VanEck Avalanche ETF', kind: 'etf' });
    expect(vavx.history).toEqual([{ date: TODAY, avax_held: 2075545, aum_usd: 17380000 }]);
  });
});

describe('parsers', () => {
  it('parse issuer number formats', () => {
    expect(treasuryService.parseNumber('2,075,545')).toBe(2075545);
    expect(treasuryService.parseNumber('0.20%')).toBe(0.2);
    expect(treasuryService.parseNumber('n/a')).toBeNull();
    expect(treasuryService.parseCompactUsd('$17.38M')).toBe(17380000);
    expect(treasuryService.parseCompactUsd('$1.2B')).toBe(1200000000);
    expect(treasuryService.parseCompactUsd('$950,000')).toBe(950000);
  });
});
