/**
 * Unit tests for rpcMetricsService.updateChain: daily metrics counted from a
 * chain's RPC. Runs against a fake chain (mocked axios) and mocked models.
 *
 * This file intentionally does NOT require ./setup; it needs no app or DB.
 */

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('../src/models/txCount', () => ({ bulkWrite: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/models/gasUsed', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/maxTps', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/feesPaid', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/avgGasPrice', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/activeAddresses', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/rpcDayAddresses', () => ({ find: jest.fn(), insertMany: jest.fn(), deleteMany: jest.fn() }));
jest.mock('../src/models/rpcTxCountState', () => ({ find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/chain', () => ({ find: jest.fn() }));
jest.mock('../src/services/tpsService', () => ({ updateTpsData: jest.fn() }));

const axios = require('axios');
const TxCount = require('../src/models/txCount');
const GasUsed = require('../src/models/gasUsed');
const MaxTps = require('../src/models/maxTps');
const FeesPaid = require('../src/models/feesPaid');
const AvgGasPrice = require('../src/models/avgGasPrice');
const ActiveAddresses = require('../src/models/activeAddresses');
const RpcDayAddresses = require('../src/models/rpcDayAddresses');
const RpcTxCountState = require('../src/models/rpcTxCountState');
const Chain = require('../src/models/chain');
const tpsService = require('../src/services/tpsService');
const { updateChain, updateAllChains } = require('../src/services/rpcMetricsService');

const DAY = 24 * 60 * 60;
const TODAY = 1_700_006_400 - (1_700_006_400 % DAY);
const NOW = TODAY + 6 * 60 * 60;
const URL = 'https://rpc.example';
const GWEI = 1e9;
const STATE_VERSION = 4;
const BACKFILL_DAYS = 365;

// Fake chain: block n has timestamp blockTimes[n] and n % 3 transactions, each
// using 21000 gas at 25 gwei. `receipts` is which receipt method the RPC has.
const txsIn = (n) => n % 3;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const OPERATOR = 7777;
const CONTRACT = 0xc0;
const address = (k) => '0x' + k.toString(16).padStart(40, '0');
const topic = (k) => '0x' + k.toString(16).padStart(64, '0');
const senderOf = (n, i) => 1 + ((n + i) % 4);
// Transaction i of block n: one of four senders calls CONTRACT, which logs a
// token transfer from the sender to 1000 + n and an Approval (its addresses
// don't count). In blocks n % 5 == 0 it also logs an ERC1155 transfer to
// 3000 + n made by OPERATOR (who doesn't count either).
const receiptFor = (n, i) => ({
  gasUsed: '0x5208',
  effectiveGasPrice: '0x' + (25 * 1e9).toString(16),
  from: address(senderOf(n, i)),
  to: address(CONTRACT),
  logs: [
    { topics: [TRANSFER, topic(senderOf(n, i)), topic(1000 + n)] },
    { topics: [APPROVAL, topic(senderOf(n, i)), topic(5000 + n)] },
    ...(n % 5 === 0 ? [{ topics: [TRANSFER_SINGLE, topic(OPERATOR), topic(senderOf(n, i)), topic(3000 + n)] }] : [])
  ]
});
// Distinct active addresses in blocks from..to.
const activeOf = (from, to) => {
  const seen = new Set();
  for (let n = from; n <= to; n++) {
    for (let i = 0; i < txsIn(n); i++) {
      seen.add(senderOf(n, i)).add(CONTRACT).add(1000 + n);
      if (n % 5 === 0) seen.add(3000 + n);
    }
  }
  return seen.size;
};
function fakeChain(blockTimes, { failFrom = Infinity, receipts = 'block', maxBatch = Infinity, syncing } = {}) {
  axios.post.mockImplementation(async (url, body) => {
    if (body.length > maxBatch) {
      throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } });
    }
    return {
      data: body.map(({ id, method, params }) => {
        const unsupported = { id, error: { code: -32601, message: `the method ${method} does not exist` } };
        if (method === 'eth_blockNumber') return { id, result: '0x' + (blockTimes.length - 1).toString(16) };
        if (method === 'eth_syncing') {
          // Avalanche's coreth RPCs don't implement it.
          return syncing === undefined ? { id, error: { code: -32000, message: 'not implemented in coreth' } } : { id, result: syncing };
        }
        if (method === 'eth_getTransactionReceipt') {
          const [block, index] = params[0].slice(2).split('-').map(Number);
          return receipts === 'tx' ? { id, result: receiptFor(block, index) } : unsupported;
        }
        const n = parseInt(params[0], 16);
        if (n >= failFrom) return { id, error: { message: 'rate limited' } };
        if (method === 'eth_getBlockReceipts') {
          return receipts === 'block'
            ? { id, result: Array.from({ length: txsIn(n) }, (_, i) => receiptFor(n, i)) }
            : unsupported;
        }
        return {
          id,
          result: {
            timestamp: '0x' + blockTimes[n].toString(16),
            transactions: Array.from({ length: txsIn(n) }, (_, i) => `0x${n}-${i}`),
            gasUsed: '0x' + (21000 * txsIn(n)).toString(16)
          }
        };
      })
    };
  });
}

// Retry waits happen at once.
const instantWaits = () => jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });

// Make the fake chain's first `times` requests fail with `error` (if `when` matches).
function failFirst(times, error, when = () => true) {
  const real = axios.post.getMockImplementation();
  let failed = 0;
  axios.post.mockImplementation(async (url, body) => {
    if (failed < times && when(body)) {
      failed++;
      throw error();
    }
    return real(url, body);
  });
}
const httpError = (status, headers = {}) => () =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, headers } });
const batchLengths = () => axios.post.mock.calls.map(([, body]) => body.length);

// A saved state; set up for the current backfill depth unless `state` says otherwise.
function stubState(state) {
  RpcTxCountState.findOne.mockReturnValue({
    lean: async () => state && { version: STATE_VERSION, backfillDays: BACKFILL_DAYS, ...state }
  });
}

// A day's running totals as kept in the state.
const totals = (fields) => ({ tx: 0, gas: 0, maxTps: 0, fees: 0, priceSum: 0, priceTxs: 0, withFees: true, ...fields });

// Rows written to a model, keyed by day timestamp.
function written(model) {
  const days = {};
  for (const [ops] of model.bulkWrite.mock.calls) {
    for (const op of ops) {
      days[op.updateOne.filter.timestamp] = op.updateOne.update.$set;
    }
  }
  return days;
}

// The state the last save wrote.
const savedState = () => RpcTxCountState.updateOne.mock.calls.at(-1)[1].$set;

const txOf = (from, to) => {
  let sum = 0;
  for (let n = from; n <= to; n++) sum += txsIn(n);
  return sum;
};

describe('rpcMetricsService.updateChain', () => {
  // No address rows saved by earlier runs unless a test says so.
  beforeEach(() => {
    RpcDayAddresses.find.mockReturnValue({ lean: async () => [] });
  });

  it('backfills from the first block of the backfill window and counts each day', async () => {
    // Blocks 0-9 before the window, 10-19 two days ago, 20-24 today.
    const times = [];
    for (let n = 0; n < 10; n++) times.push(TODAY - 400 * DAY + n);
    for (let n = 10; n < 20; n++) times.push(TODAY - 2 * DAY + n);
    for (let n = 20; n < 25; n++) times.push(TODAY + n);
    fakeChain(times);
    stubState(null);

    const result = await updateChain('1', URL, { now: NOW });

    expect(result).toMatchObject({ success: true, blocksCounted: 15, caughtUp: true });
    const days = written(TxCount);
    expect(days[TODAY - 2 * DAY]).toEqual(expect.objectContaining({ value: txOf(10, 19), source: 'rpc' }));
    // No blocks yesterday, but blocks after it: a real 0.
    expect(days[TODAY - DAY].value).toBe(0);
    // Today's running count, like the metrics API's in-progress bucket.
    expect(days[TODAY].value).toBe(txOf(20, 24));
    // Quiet days in the window are 0 as well, back to its first day.
    expect(days[TODAY - 30 * DAY].value).toBe(0);
    expect(days[TODAY - BACKFILL_DAYS * DAY].value).toBe(0);
    expect(days[TODAY - (BACKFILL_DAYS + 1) * DAY]).toBeUndefined();
  });

  it('stops at the head when asked for live days only, leaving the backfill for later', async () => {
    // Blocks 0-9 before the window, 10-19 two days ago, 20-24 today.
    const times = [];
    for (let n = 0; n < 10; n++) times.push(TODAY - 400 * DAY + n);
    for (let n = 10; n < 20; n++) times.push(TODAY - 2 * DAY + n);
    for (let n = 20; n < 25; n++) times.push(TODAY + n);
    fakeChain(times);
    stubState(null);

    const result = await updateChain('1', URL, { now: NOW, liveOnly: true });

    expect(result).toMatchObject({ success: true, blocksCounted: 5, caughtUp: true, backfilling: true });
    const days = written(TxCount);
    expect(days[TODAY].value).toBe(txOf(20, 24));
    expect(days[TODAY - DAY].value).toBe(0);
    expect(days[TODAY - 2 * DAY]).toBeUndefined();
    expect(savedState().backfill).toMatchObject({ day: TODAY - 2 * DAY, endBlock: 19 });
  });

  it.each(['block', 'tx'])('derives gas used, max TPS, fees and average gas price (%s receipts)', async (receipts) => {
    // Two days ago. Block rates (tx / seconds since parent): block 1 is 1/5,
    // block 2 shares its parent's second so 2/1, block 5 is 2/8.
    const times = [TODAY - 2 * DAY, TODAY - 2 * DAY + 5, TODAY - 2 * DAY + 5, TODAY - 2 * DAY + 9,
      TODAY - 2 * DAY + 12, TODAY - 2 * DAY + 20, TODAY + 1];
    fakeChain(times, { receipts });
    stubState({ lastBlock: -1, lastTimestamp: null, dayTimestamp: TODAY - 2 * DAY, day: totals() });

    await updateChain('1', URL, { now: NOW });

    const day = TODAY - 2 * DAY;
    const tx = txOf(0, 5);
    expect(written(TxCount)[day].value).toBe(tx);
    expect(written(GasUsed)[day].value).toBe(21000 * tx);
    expect(written(MaxTps)[day].value).toBe(2);
    expect(written(FeesPaid)[day].value).toBeCloseTo(tx * 21000 * 25e-9, 12);
    expect(written(AvgGasPrice)[day].value).toBeCloseTo(25, 9);
    expect(written(ActiveAddresses)[day]).toEqual(expect.objectContaining({ value: activeOf(0, 5), source: 'rpc' }));
    // Yesterday had no blocks: 0 fees and addresses, but no average gas price row.
    expect(written(FeesPaid)[TODAY - DAY].value).toBe(0);
    expect(written(ActiveAddresses)[TODAY - DAY].value).toBe(0);
    expect(written(AvgGasPrice)[TODAY - DAY]).toBeUndefined();
  });

  it('counts transaction and token transfer addresses once per day', async () => {
    // Blocks 0-6 two days ago; 7 today.
    const times = [];
    for (let n = 0; n < 7; n++) times.push(TODAY - 2 * DAY + n);
    times.push(TODAY + 1);
    fakeChain(times);
    stubState({ lastBlock: -1, lastTimestamp: null, dayTimestamp: TODAY - 2 * DAY, day: totals() });

    await updateChain('1', URL, { now: NOW });

    // Senders 1-4 (repeated across blocks), CONTRACT, transfer recipients
    // 1001, 1002, 1004, 1005 and ERC1155 recipient 3005; not OPERATOR or
    // Approval spenders. Block 0, 3 and 6 have no transactions.
    expect(activeOf(0, 6)).toBe(10);
    expect(written(ActiveAddresses)[TODAY - 2 * DAY].value).toBe(10);
  });

  it('carries a day\'s addresses across runs without counting any twice', async () => {
    // Yesterday: blocks 0-29, counted over two runs; then today.
    const times = [];
    for (let n = 0; n < 30; n++) times.push(TODAY - DAY + n);
    times.push(TODAY + 1);
    fakeChain(times);
    stubState({ lastBlock: -1, lastTimestamp: null, dayTimestamp: TODAY - DAY, day: totals() });

    await updateChain('1', URL, { now: NOW, maxBlocks: 15 });

    // Not caught up: yesterday stays open, its addresses saved for the next run.
    expect(ActiveAddresses.bulkWrite).not.toHaveBeenCalled();
    const rows = RpcDayAddresses.insertMany.mock.calls.flatMap(([docs]) => docs);
    expect(rows.every(row => row.chainId === '1' && row.day === TODAY - DAY)).toBe(true);
    expect(rows.reduce((n, row) => n + row.addresses.length / 20, 0)).toBe(activeOf(0, 14));
    expect(RpcDayAddresses.deleteMany).toHaveBeenLastCalledWith({ chainId: '1', day: { $nin: [TODAY - DAY] } });

    const state = savedState();
    RpcTxCountState.findOne.mockReturnValue({ lean: async () => state });
    RpcDayAddresses.find.mockReturnValue({ lean: async () => rows });
    RpcDayAddresses.insertMany.mockClear();

    await updateChain('1', URL, { now: NOW });

    // Senders and CONTRACT were seen in both runs; each counts once.
    expect(RpcDayAddresses.find).toHaveBeenCalledWith({ chainId: '1', day: TODAY - DAY });
    expect(written(ActiveAddresses)[TODAY - DAY].value).toBe(activeOf(0, 29));
    expect(written(ActiveAddresses)[TODAY].value).toBe(0);
    // Yesterday is written: only today's addresses are kept.
    expect(RpcDayAddresses.deleteMany).toHaveBeenLastCalledWith({ chainId: '1', day: { $nin: [TODAY] } });
  });

  it('keeps the backfill day\'s addresses when a run stops partway through it', async () => {
    // Two days ago: blocks 0-29; yesterday: 30-39; today: 40.
    const times = [];
    for (let n = 0; n < 30; n++) times.push(TODAY - 2 * DAY + n);
    for (let n = 30; n < 40; n++) times.push(TODAY - DAY + n);
    times.push(TODAY + 1);
    fakeChain(times);
    stubState(null);

    await updateChain('1', URL, { now: NOW, maxBlocks: 31 });

    // Yesterday and today counted (11 blocks), then 20 blocks into two days ago
    // from its first block.
    expect(written(ActiveAddresses)[TODAY - DAY].value).toBe(activeOf(30, 39));
    expect(written(ActiveAddresses)[TODAY - 2 * DAY]).toBeUndefined();
    const rows = RpcDayAddresses.insertMany.mock.calls.flatMap(([docs]) => docs)
      .filter(row => row.day === TODAY - 2 * DAY);
    expect(rows.reduce((n, row) => n + row.addresses.length / 20, 0)).toBe(activeOf(0, 19));
    expect(RpcDayAddresses.deleteMany).toHaveBeenLastCalledWith({ chainId: '1', day: { $nin: [TODAY, TODAY - 2 * DAY] } });
  });

  it('skips fees and gas price when the RPC returns no receipts', async () => {
    const times = [TODAY - DAY + 1, TODAY - DAY + 2, TODAY + 1];
    fakeChain(times, { receipts: 'none' });
    stubState({ lastBlock: -1, lastTimestamp: null, dayTimestamp: TODAY - DAY, day: totals() });

    const result = await updateChain('1', URL, { now: NOW });

    expect(result.success).toBe(true);
    expect(written(TxCount)[TODAY - DAY].value).toBe(txOf(0, 1));
    expect(FeesPaid.bulkWrite).not.toHaveBeenCalled();
    expect(AvgGasPrice.bulkWrite).not.toHaveBeenCalled();
    expect(ActiveAddresses.bulkWrite).not.toHaveBeenCalled();
    expect(RpcTxCountState.updateOne).toHaveBeenLastCalledWith(
      { chainId: '1' }, { $set: expect.objectContaining({ feeSource: 'none' }) }, { upsert: true }
    );
  });

  it('resumes after the last counted block', async () => {
    const times = [];
    for (let n = 0; n < 10; n++) times.push(TODAY + n);
    fakeChain(times);
    stubState({ lastBlock: 4, dayTimestamp: TODAY, day: totals({ tx: 100 }), lastTimestamp: TODAY + 4 });

    const result = await updateChain('1', URL, { now: NOW });

    expect(result.blocksCounted).toBe(5);
    expect(written(TxCount)[TODAY].value).toBe(100 + txOf(5, 9));
    expect(RpcTxCountState.updateOne).toHaveBeenLastCalledWith(
      { chainId: '1' },
      { $set: expect.objectContaining({ version: STATE_VERSION, lastBlock: 9, dayTimestamp: TODAY, lastError: null }) },
      { upsert: true }
    );
  });

  it.each([
    ['an unversioned state', { lastBlock: 8, dayTimestamp: TODAY - DAY, dayCount: 7 }],
    ['a version 3 state (before active addresses)', {
      version: 3, backfillDays: BACKFILL_DAYS, lastBlock: 8, lastTimestamp: TODAY - DAY + 8,
      dayTimestamp: TODAY - DAY, day: totals({ tx: 5 }), backfill: null, feeSource: 'block'
    }],
    ['a state whose first run never found its first block', { version: STATE_VERSION, backfillDays: BACKFILL_DAYS }]
  ])('restarts counting for %s', async (label, saved) => {
    const times = [];
    for (let n = 0; n < 5; n++) times.push(TODAY - 400 * DAY + n);
    for (let n = 5; n < 10; n++) times.push(TODAY - DAY + n);
    fakeChain(times);
    RpcTxCountState.findOne.mockReturnValue({ lean: async () => saved });

    const result = await updateChain('1', URL, { now: NOW });

    expect(result.blocksCounted).toBe(5);
    expect(written(TxCount)[TODAY - DAY].value).toBe(txOf(5, 9));
    expect(written(ActiveAddresses)[TODAY - DAY].value).toBe(activeOf(5, 9));
    // Address rows from before don't belong to the restarted count.
    expect(RpcDayAddresses.deleteMany).toHaveBeenCalledWith({ chainId: '1' });
    expect(savedState()).toEqual(expect.objectContaining({ version: STATE_VERSION, backfillDays: BACKFILL_DAYS }));
  });

  it('leaves an unfinished day unwritten when the RPC fails', async () => {
    // 150 blocks yesterday, then today; the RPC fails from block 120 on.
    const times = [];
    for (let n = 0; n < 150; n++) times.push(TODAY - DAY + n);
    for (let n = 150; n < 160; n++) times.push(TODAY + n);
    fakeChain(times, { failFrom: 120 });
    stubState({ lastBlock: -1, dayTimestamp: TODAY - DAY, day: totals(), lastTimestamp: null });
    instantWaits();

    const result = await updateChain('1', URL, { now: NOW });

    expect(result).toMatchObject({ success: false, blocksCounted: 100 });
    expect(TxCount.bulkWrite).not.toHaveBeenCalled();
    // Progress up to the last complete batch is kept for the next run.
    expect(RpcTxCountState.updateOne).toHaveBeenLastCalledWith(
      { chainId: '1' },
      {
        $set: expect.objectContaining({
          lastBlock: 99,
          day: expect.objectContaining({ tx: txOf(0, 99) }),
          lastError: expect.stringMatching(/rate limited/)
        })
      },
      { upsert: true }
    );
  });

  it('caps the blocks walked per run and does not close days before reaching the head', async () => {
    const times = [];
    for (let n = 0; n < 50; n++) times.push(TODAY - 3 * DAY + n);
    fakeChain(times);
    stubState({ lastBlock: -1, dayTimestamp: TODAY - 3 * DAY, day: totals(), lastTimestamp: null });

    const result = await updateChain('1', URL, { now: NOW, maxBlocks: 20 });

    expect(result).toMatchObject({ success: true, blocksCounted: 20, caughtUp: false });
    expect(TxCount.bulkWrite).not.toHaveBeenCalled();
  });

  it('splits requests into smaller batches when the RPC rejects large ones', async () => {
    const times = [];
    for (let n = 0; n < 120; n++) times.push(TODAY - DAY + n);
    times.push(TODAY + 1);
    fakeChain(times, { maxBatch: 40 });
    stubState({ lastBlock: -1, lastTimestamp: null, dayTimestamp: TODAY - DAY, day: totals() });
    instantWaits();

    const result = await updateChain('1', 'https://small-batches.example', { now: NOW });

    expect(result).toMatchObject({ success: true, blocksCounted: 121 });
    expect(written(TxCount)[TODAY - DAY].value).toBe(txOf(0, 119));
  });

  it('stops at the deadline, keeping progress and not closing days', async () => {
    const times = [];
    for (let n = 0; n < 50; n++) times.push(TODAY - 3 * DAY + n);
    fakeChain(times);
    stubState({ lastBlock: 9, lastTimestamp: TODAY - 3 * DAY + 9, dayTimestamp: TODAY - 3 * DAY, day: totals({ tx: 7 }) });

    const result = await updateChain('1', URL, { now: NOW, deadline: Date.now() - 1 });

    expect(result).toMatchObject({ success: true, blocksCounted: 0, caughtUp: false });
    expect(TxCount.bulkWrite).not.toHaveBeenCalled();
    expect(tpsService.updateTpsData).not.toHaveBeenCalled();
    expect(RpcTxCountState.updateOne).toHaveBeenLastCalledWith(
      { chainId: '1' },
      { $set: expect.objectContaining({ lastBlock: 9, day: expect.objectContaining({ tx: 7 }) }) },
      { upsert: true }
    );
  });

  it('counts yesterday first, then older days newest first across runs', async () => {
    // Blocks 0-49 three days ago, none two days ago, 50-59 yesterday, 60-64 today.
    const times = [];
    for (let n = 0; n < 50; n++) times.push(TODAY - 3 * DAY + n);
    for (let n = 50; n < 60; n++) times.push(TODAY - DAY + n);
    for (let n = 60; n < 65; n++) times.push(TODAY + n);
    fakeChain(times);
    stubState(null);

    // First run: 20 blocks, so only 5 left for three days ago.
    const first = await updateChain('1', URL, { now: NOW, maxBlocks: 20 });

    expect(first).toMatchObject({ success: true, blocksCounted: 20, caughtUp: true });
    let days = written(TxCount);
    expect(days[TODAY - DAY].value).toBe(txOf(50, 59));
    expect(days[TODAY].value).toBe(txOf(60, 64));
    // TPS follows each write, not the end of the run.
    expect(tpsService.updateTpsData).toHaveBeenCalledWith('1');
    expect(days[TODAY - 2 * DAY].value).toBe(0);
    expect(days[TODAY - 3 * DAY]).toBeUndefined();
    const saved = RpcTxCountState.updateOne.mock.calls.at(-1)[1].$set;
    expect(saved.backfill).toMatchObject({ day: TODAY - 3 * DAY, nextBlock: 5 });

    // Next run picks up three days ago where it stopped.
    TxCount.bulkWrite.mockClear();
    stubState(saved);
    await updateChain('1', URL, { now: NOW });

    days = written(TxCount);
    expect(days[TODAY - 3 * DAY].value).toBe(txOf(0, 49));
    expect(written(MaxTps)[TODAY - 3 * DAY].value).toBe(2);
    // Block 0 is three days ago: older days get no rows, not 0.
    expect(days[TODAY - 4 * DAY]).toBeUndefined();
    expect(RpcTxCountState.updateOne.mock.calls.at(-1)[1].$set.backfill).toBeNull();
  });

  it('lowers a running backfill\'s floor for a state set up for 30 days', async () => {
    const times = [];
    for (let n = 0; n < 10; n++) times.push(TODAY - 60 * DAY + n);
    for (let n = 10; n < 20; n++) times.push(TODAY - 31 * DAY + n);
    for (let n = 20; n < 25; n++) times.push(TODAY + n);
    fakeChain(times);
    stubState({
      backfillDays: undefined,
      lastBlock: 24,
      lastTimestamp: TODAY + 24,
      dayTimestamp: TODAY,
      day: totals(),
      backfill: { day: TODAY - 30 * DAY, floor: TODAY - 30 * DAY, endBlock: 19 }
    });

    await updateChain('1', URL, { now: NOW });

    const days = written(TxCount);
    expect(days[TODAY - 31 * DAY].value).toBe(txOf(10, 19));
    expect(days[TODAY - 60 * DAY].value).toBe(txOf(0, 9));
    expect(days[TODAY - 61 * DAY]).toBeUndefined();
    expect(RpcTxCountState.updateOne.mock.calls.at(-1)[1].$set).toMatchObject({ backfill: null, backfillDays: BACKFILL_DAYS });
  });

  it('restarts a finished 30-day backfill below the oldest stored day', async () => {
    const times = [];
    for (let n = 0; n < 10; n++) times.push(TODAY - 45 * DAY + n);
    for (let n = 10; n < 20; n++) times.push(TODAY - 30 * DAY + n);
    for (let n = 20; n < 25; n++) times.push(TODAY + n);
    fakeChain(times);
    TxCount.findOne.mockReturnValue({
      sort: () => ({ select: () => ({ lean: async () => ({ timestamp: TODAY - 30 * DAY }) }) })
    });
    stubState({ backfillDays: undefined, lastBlock: 24, lastTimestamp: TODAY + 24, dayTimestamp: TODAY, day: totals(), backfill: null });

    await updateChain('1', URL, { now: NOW });

    const days = written(TxCount);
    // The stored days are not recounted.
    expect(days[TODAY - 30 * DAY]).toBeUndefined();
    expect(days[TODAY - 31 * DAY].value).toBe(0);
    expect(days[TODAY - 45 * DAY].value).toBe(txOf(0, 9));
    expect(days[TODAY - 46 * DAY]).toBeUndefined();
  });

  it('retries a passing server error without shrinking the batch', async () => {
    const times = [];
    for (let n = 0; n < 120; n++) times.push(TODAY - DAY + n);
    times.push(TODAY + 1);
    fakeChain(times);
    failFirst(1, httpError(500), body => body.length === 100);
    stubState({ lastBlock: -1, lastTimestamp: null, dayTimestamp: TODAY - DAY, day: totals() });
    instantWaits();

    const result = await updateChain('1', 'https://transient.example', { now: NOW });

    expect(result).toMatchObject({ success: true, blocksCounted: 121 });
    expect(batchLengths()).not.toContain(50);
  });

  it('waits out a rate limit instead of giving up', async () => {
    const times = [TODAY - DAY + 1, TODAY - DAY + 2, TODAY + 1];
    fakeChain(times);
    failFirst(2, httpError(429, { 'retry-after': '3' }), body => body[0].method === 'eth_getBlockByNumber');
    stubState({ lastBlock: -1, lastTimestamp: null, dayTimestamp: TODAY - DAY, day: totals() });
    const waits = instantWaits();

    const result = await updateChain('1', 'https://rate-limited.example', { now: NOW });

    expect(result).toMatchObject({ success: true, blocksCounted: 3 });
    expect(written(TxCount)[TODAY - DAY].value).toBe(txOf(0, 1));
    expect(waits).toHaveBeenCalledWith(expect.any(Function), 3000);
  });

  it('grows the batch size back after a run of successes', async () => {
    const times = [];
    for (let n = 0; n < 3000; n++) times.push(TODAY - DAY + n);
    times.push(TODAY + 1);
    fakeChain(times);
    // Batches of 100 fail through every retry once, then the RPC recovers.
    failFirst(3, httpError(500), body => body.length === 100);
    stubState({ lastBlock: -1, lastTimestamp: null, dayTimestamp: TODAY - DAY, day: totals() });
    instantWaits();

    const result = await updateChain('1', 'https://recovers.example', { now: NOW });

    expect(result.success).toBe(true);
    const lengths = batchLengths();
    const shrunk = lengths.indexOf(50);
    expect(shrunk).toBeGreaterThan(-1);
    expect(lengths.slice(shrunk)).toContain(100);
  });

  it('writes nothing when the RPC node is syncing', async () => {
    fakeChain([TODAY - 5 * DAY], { syncing: { currentBlock: '0x1' } });
    stubState({ lastBlock: 0, lastTimestamp: TODAY - 5 * DAY, dayTimestamp: TODAY - 5 * DAY, day: totals() });

    const result = await updateChain('1', URL, { now: NOW });

    expect(result).toMatchObject({ success: false, error: 'RPC node is syncing' });
    expect(TxCount.bulkWrite).not.toHaveBeenCalled();
  });
});

describe('rpcMetricsService.updateAllChains', () => {
  const query = (rows) => {
    const q = { select: () => q, sort: () => q, lean: async () => rows };
    return q;
  };

  it('leaves chains for the next run once the deadline has passed', async () => {
    RpcTxCountState.find.mockReturnValue(query([{ chainId: '2' }, { chainId: '1' }]));
    Chain.find.mockReturnValue(query([
      { evmChainId: 1, rpcUrl: URL },
      { evmChainId: 2, rpcUrl: URL }
    ]));

    const result = await updateAllChains({ deadline: Date.now() - 1 });

    expect(result).toMatchObject({ success: true, chains: 2, succeeded: 0 });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('catches every chain up to its head before any chain backfills', async () => {
    // Blocks 0-9 before the window, 10-19 two days ago, 20-24 today.
    const times = [];
    for (let n = 0; n < 10; n++) times.push(TODAY - 400 * DAY + n);
    for (let n = 10; n < 20; n++) times.push(TODAY - 2 * DAY + n);
    for (let n = 20; n < 25; n++) times.push(TODAY + n);
    fakeChain(times);
    RpcDayAddresses.find.mockReturnValue({ lean: async () => [] });
    // States persist between a chain's calls, like the real collection.
    const states = new Map();
    RpcTxCountState.findOne.mockImplementation(({ chainId }) => ({ lean: async () => states.get(chainId) || null }));
    RpcTxCountState.updateOne.mockImplementation(async ({ chainId }, { $set }) => {
      states.set(chainId, { ...states.get(chainId), ...$set });
    });
    // More chains than run at once (3), so a backfill could take a slot a
    // live update is waiting for.
    const ids = ['1', '2', '3', '4'];
    RpcTxCountState.find.mockReturnValue(query(ids.map(chainId => ({ chainId }))));
    Chain.find.mockReturnValue(query(ids.map(id => ({ evmChainId: Number(id), rpcUrl: URL }))));

    const result = await updateAllChains({ now: NOW, deadline: Date.now() + 60_000 });

    expect(result).toMatchObject({ success: true, chains: 4, succeeded: 4, backfilled: 4 });
    const calls = RpcTxCountState.findOne.mock.calls.map(([filter]) => filter.chainId);
    expect(calls.slice(0, 4)).toEqual(ids);
    expect([...calls.slice(4)].sort()).toEqual(ids);
    for (const id of ids) {
      const backfilled = TxCount.bulkWrite.mock.calls.some(([ops]) =>
        ops.some(op => op.updateOne.filter.chainId === id && op.updateOne.filter.timestamp === TODAY - 2 * DAY));
      expect(backfilled).toBe(true);
    }
  });
});
