/**
 * Unit tests for rpcMetricsService.updateChain: daily metrics counted from a
 * chain's RPC. Runs against a fake chain (mocked axios) and mocked models.
 *
 * This file intentionally does NOT require ./setup; it needs no app or DB.
 */

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('../src/models/txCount', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/gasUsed', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/maxTps', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/feesPaid', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/avgGasPrice', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/rpcTxCountState', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/chain', () => ({ find: jest.fn() }));

const axios = require('axios');
const TxCount = require('../src/models/txCount');
const GasUsed = require('../src/models/gasUsed');
const MaxTps = require('../src/models/maxTps');
const FeesPaid = require('../src/models/feesPaid');
const AvgGasPrice = require('../src/models/avgGasPrice');
const RpcTxCountState = require('../src/models/rpcTxCountState');
const { updateChain } = require('../src/services/rpcMetricsService');

const DAY = 24 * 60 * 60;
const TODAY = 1_700_006_400 - (1_700_006_400 % DAY);
const NOW = TODAY + 6 * 60 * 60;
const URL = 'https://rpc.example';
const GWEI = 1e9;
const STATE_VERSION = 2;

// Fake chain: block n has timestamp blockTimes[n] and n % 3 transactions, each
// using 21000 gas at 25 gwei. `receipts` is which receipt method the RPC has.
const txsIn = (n) => n % 3;
const receipt = { gasUsed: '0x5208', effectiveGasPrice: '0x' + (25 * 1e9).toString(16) };
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
          return receipts === 'tx' ? { id, result: receipt } : unsupported;
        }
        const n = parseInt(params[0], 16);
        if (n >= failFrom) return { id, error: { message: 'rate limited' } };
        if (method === 'eth_getBlockReceipts') {
          return receipts === 'block' ? { id, result: new Array(txsIn(n)).fill(receipt) } : unsupported;
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

function stubState(state) {
  RpcTxCountState.findOne.mockReturnValue({ lean: async () => state && { version: STATE_VERSION, ...state } });
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

const txOf = (from, to) => {
  let sum = 0;
  for (let n = from; n <= to; n++) sum += txsIn(n);
  return sum;
};

describe('rpcMetricsService.updateChain', () => {
  it('backfills from the first block of the backfill window and counts each day', async () => {
    // Blocks 0-9 before the window, 10-19 two days ago, 20-24 today.
    const times = [];
    for (let n = 0; n < 10; n++) times.push(TODAY - 40 * DAY + n);
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
    // Days in the window before the first block are 0 as well.
    expect(days[TODAY - 30 * DAY].value).toBe(0);
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
    // Yesterday had no blocks: 0 fees, but no average gas price row.
    expect(written(FeesPaid)[TODAY - DAY].value).toBe(0);
    expect(written(AvgGasPrice)[TODAY - DAY]).toBeUndefined();
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

  it('restarts the backfill for a state saved by an older version', async () => {
    const times = [];
    for (let n = 0; n < 5; n++) times.push(TODAY - 40 * DAY + n);
    for (let n = 5; n < 10; n++) times.push(TODAY - DAY + n);
    fakeChain(times);
    RpcTxCountState.findOne.mockReturnValue({ lean: async () => ({ lastBlock: 8, dayTimestamp: TODAY - DAY, dayCount: 7 }) });

    const result = await updateChain('1', URL, { now: NOW });

    expect(result.blocksCounted).toBe(5);
    expect(written(TxCount)[TODAY - DAY].value).toBe(txOf(5, 9));
  });

  it('leaves an unfinished day unwritten when the RPC fails', async () => {
    // 150 blocks yesterday, then today; the RPC fails from block 120 on.
    const times = [];
    for (let n = 0; n < 150; n++) times.push(TODAY - DAY + n);
    for (let n = 150; n < 160; n++) times.push(TODAY + n);
    fakeChain(times, { failFrom: 120 });
    stubState({ lastBlock: -1, dayTimestamp: TODAY - DAY, day: totals(), lastTimestamp: null });

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

    const result = await updateChain('1', URL, { now: NOW });

    expect(result).toMatchObject({ success: true, blocksCounted: 121 });
    expect(written(TxCount)[TODAY - DAY].value).toBe(txOf(0, 119));
  });

  it('writes nothing when the RPC node is syncing', async () => {
    fakeChain([TODAY - 5 * DAY], { syncing: { currentBlock: '0x1' } });
    stubState({ lastBlock: 0, lastTimestamp: TODAY - 5 * DAY, dayTimestamp: TODAY - 5 * DAY, day: totals() });

    const result = await updateChain('1', URL, { now: NOW });

    expect(result).toMatchObject({ success: false, error: 'RPC node is syncing' });
    expect(TxCount.bulkWrite).not.toHaveBeenCalled();
  });
});
