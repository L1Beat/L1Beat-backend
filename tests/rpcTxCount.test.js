/**
 * Unit tests for rpcTxCountService.updateChain: daily txCount counted from a
 * chain's RPC. Runs against a fake chain (mocked axios) and mocked models.
 *
 * This file intentionally does NOT require ./setup; it needs no app or DB.
 */

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('../src/models/txCount', () => ({ bulkWrite: jest.fn() }));
jest.mock('../src/models/rpcTxCountState', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/chain', () => ({ find: jest.fn() }));

const axios = require('axios');
const TxCount = require('../src/models/txCount');
const RpcTxCountState = require('../src/models/rpcTxCountState');
const { updateChain } = require('../src/services/rpcTxCountService');

const DAY = 24 * 60 * 60;
const TODAY = 1_700_006_400 - (1_700_006_400 % DAY);
const NOW = TODAY + 6 * 60 * 60;
const URL = 'https://rpc.example';

// Fake chain: block n has timestamp blockTimes[n] and n % 3 transactions.
function fakeChain(blockTimes, { failFrom = Infinity, syncing = false } = {}) {
  axios.post.mockImplementation(async (url, body) => ({
    data: body.map(({ id, method, params }) => {
      if (method === 'eth_blockNumber') return { id, result: '0x' + (blockTimes.length - 1).toString(16) };
      if (method === 'eth_syncing') return { id, result: syncing };
      const n = parseInt(params[0], 16);
      if (n >= failFrom) return { id, error: { message: 'rate limited' } };
      return {
        id,
        result: { timestamp: '0x' + blockTimes[n].toString(16), transactions: new Array(n % 3).fill('0x') }
      };
    })
  }));
}

function stubState(state) {
  RpcTxCountState.findOne.mockReturnValue({ lean: async () => state });
}

// All TxCount rows written, keyed by day timestamp.
function writtenDays() {
  const days = {};
  for (const [ops] of TxCount.bulkWrite.mock.calls) {
    for (const op of ops) {
      days[op.updateOne.filter.timestamp] = op.updateOne.update.$set;
    }
  }
  return days;
}

const txOf = (from, to) => {
  let sum = 0;
  for (let n = from; n <= to; n++) sum += n % 3;
  return sum;
};

describe('rpcTxCountService.updateChain', () => {
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
    const days = writtenDays();
    expect(days[TODAY - 2 * DAY]).toEqual(expect.objectContaining({ value: txOf(10, 19), source: 'rpc' }));
    // No blocks yesterday, but blocks after it: a real 0.
    expect(days[TODAY - DAY].value).toBe(0);
    // Today's running count, like the metrics API's in-progress bucket.
    expect(days[TODAY].value).toBe(txOf(20, 24));
    // Days in the window before the first block are 0 as well.
    expect(days[TODAY - 30 * DAY].value).toBe(0);
  });

  it('resumes after the last counted block', async () => {
    const times = [];
    for (let n = 0; n < 10; n++) times.push(TODAY + n);
    fakeChain(times);
    stubState({ lastBlock: 4, dayTimestamp: TODAY, dayCount: 100 });

    const result = await updateChain('1', URL, { now: NOW });

    expect(result.blocksCounted).toBe(5);
    expect(writtenDays()[TODAY].value).toBe(100 + txOf(5, 9));
    expect(RpcTxCountState.updateOne).toHaveBeenLastCalledWith(
      { chainId: '1' },
      { $set: expect.objectContaining({ lastBlock: 9, dayTimestamp: TODAY, dayCount: 100 + txOf(5, 9), lastError: null }) },
      { upsert: true }
    );
  });

  it('leaves an unfinished day unwritten when the RPC fails', async () => {
    // 150 blocks yesterday, then today; the RPC fails from block 120 on.
    const times = [];
    for (let n = 0; n < 150; n++) times.push(TODAY - DAY + n);
    for (let n = 150; n < 160; n++) times.push(TODAY + n);
    fakeChain(times, { failFrom: 120 });
    stubState({ lastBlock: -1, dayTimestamp: TODAY - DAY, dayCount: 0 });

    const result = await updateChain('1', URL, { now: NOW });

    expect(result).toMatchObject({ success: false, blocksCounted: 100 });
    expect(TxCount.bulkWrite).not.toHaveBeenCalled();
    // Progress up to the last complete batch is kept for the next run.
    expect(RpcTxCountState.updateOne).toHaveBeenLastCalledWith(
      { chainId: '1' },
      { $set: expect.objectContaining({ lastBlock: 99, dayCount: txOf(0, 99), lastError: expect.stringMatching(/rate limited/) }) },
      { upsert: true }
    );
  });

  it('caps the blocks walked per run and does not close days before reaching the head', async () => {
    const times = [];
    for (let n = 0; n < 50; n++) times.push(TODAY - 3 * DAY + n);
    fakeChain(times);
    stubState({ lastBlock: -1, dayTimestamp: TODAY - 3 * DAY, dayCount: 0 });

    const result = await updateChain('1', URL, { now: NOW, maxBlocks: 20 });

    expect(result).toMatchObject({ success: true, blocksCounted: 20, caughtUp: false });
    expect(TxCount.bulkWrite).not.toHaveBeenCalled();
  });

  it('writes nothing when the RPC node is syncing', async () => {
    fakeChain([TODAY - 5 * DAY], { syncing: { currentBlock: '0x1' } });
    stubState({ lastBlock: 0, dayTimestamp: TODAY - 5 * DAY, dayCount: 0 });

    const result = await updateChain('1', URL, { now: NOW });

    expect(result).toMatchObject({ success: false, error: 'RPC node is syncing' });
    expect(TxCount.bulkWrite).not.toHaveBeenCalled();
  });
});
