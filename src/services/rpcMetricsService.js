const axios = require('axios');
const pLimit = require('p-limit');
const TxCount = require('../models/txCount');
const GasUsed = require('../models/gasUsed');
const MaxTps = require('../models/maxTps');
const FeesPaid = require('../models/feesPaid');
const AvgGasPrice = require('../models/avgGasPrice');
const RpcTxCountState = require('../models/rpcTxCountState');
const Chain = require('../models/chain');
const logger = require('../utils/logger');

// Daily metrics for chains the metrics API doesn't cover (it returns 404),
// counted from the chain's own public RPC and stored in the same collections
// as the metrics API's rows, with source 'rpc'. TPS derivation and the metric
// routes then work unchanged. Per UTC day, matching the metrics API (checked
// against it on Beam and Dinari):
//   txCount      transactions
//   gasUsed      gas units
//   maxTps       highest block rate: a block's transactions / seconds since
//                its parent block (at least 1)
//   feesPaid     native token: sum of gasUsed * effectiveGasPrice
//   avgGasPrice  gwei: mean effectiveGasPrice per transaction
// Fees and gas price come from receipts: eth_getBlockReceipts where the RPC
// has it, else one eth_getTransactionReceipt per transaction (Avalanche's
// public subnets.avax.network RPCs). Base fee * gas is not used: tips are a
// large share of fees on these chains.
//
// Newest days first: live counting starts at yesterday and keeps up with the
// head; leftover time in a run counts older days back to BACKFILL_DAYS. Progress
// is kept in RpcTxCountState and a UTC day is written once all of its blocks
// are counted.
// A failed RPC stops that chain's run at the last complete batch, so a day is
// never written from a partial count: it stays missing (null) instead of 0.

const DAY_SECONDS = 24 * 60 * 60;
const BACKFILL_DAYS = 30;
const BLOCKS_PER_STEP = 100;
// Calls per JSON-RPC batch. Halved for an RPC that rejects a batch as too
// large (subnets.avax.network fails above ~40), down to MIN_BATCH_SIZE.
const BATCH_SIZE = 100;
const MIN_BATCH_SIZE = 5;
// Third-party RPCs: few requests at a time, and a cap per run so a busy chain's
// 30-day backfill spreads over several hourly runs instead of one long one.
const MAX_BLOCKS_PER_RUN = 250000;
// A run stops by this deadline so it ends before the next hourly run starts;
// chains pick up where they stopped. Progress is saved at least this often, so
// a restart mid-run loses little.
const RUN_BUDGET_MS = 45 * 60 * 1000;
const SAVE_INTERVAL_MS = 60 * 1000;
const CHAIN_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 20000;
const RETRIES = 3;
// Bump when the counted metrics change: older states restart the backfill so
// every day gets the new metrics. Version 2 (oldest day first) states are
// converted, keeping the days they wrote.
const STATE_VERSION = 3;
const WEI_PER_GWEI = 1e9;
const WEI_PER_TOKEN = 1e18;

const dayStart = (ts) => ts - (ts % DAY_SECONDS);
const toHex = (n) => '0x' + n.toString(16);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const newDay = (withFees) => ({ tx: 0, gas: 0, maxTps: 0, fees: 0, priceSum: 0, priceTxs: 0, withFees });

let running = false;
const batchSizes = new Map(); // rpc url -> calls per batch it accepts

// The RPC doesn't offer this method; retrying won't help.
const isUnsupported = (error) =>
  error.rpcCode === -32601 || /not (found|supported|available|implemented)|does not exist/i.test(error.message);

// Send one JSON-RPC batch, with retries. Results are in call order.
async function sendBatch(url, calls) {
  const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
  for (let attempt = 1; ; attempt++) {
    try {
      let response;
      try {
        response = await axios.post(url, body, {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        const status = error.response && error.response.status;
        if (calls.length > MIN_BATCH_SIZE && (status === 413 || status >= 500)) {
          error.batchTooLarge = true;
        }
        throw error;
      }
      const { data } = response;
      if (!Array.isArray(data)) {
        const error = new Error('RPC did not return a batch response');
        // e.g. a single error object for the whole batch ("batch too large").
        error.batchTooLarge = calls.length > MIN_BATCH_SIZE;
        throw error;
      }
      const byId = new Map(data.map(r => [r.id, r]));
      return calls.map((call, id) => {
        const r = byId.get(id);
        if (!r || r.error || r.result === undefined) {
          const error = new Error(`${call[0]} failed: ${r && r.error ? r.error.message : 'missing result'}`);
          error.rpcCode = r && r.error ? r.error.code : undefined;
          throw error;
        }
        return r.result;
      });
    } catch (error) {
      if (attempt >= RETRIES || error.batchTooLarge || isUnsupported(error)) throw error;
      await sleep(2000 * attempt);
    }
  }
}

/**
 * Run calls as JSON-RPC batches no larger than the RPC accepts and return the
 * results in call order. Throws if a batch fails after retries or any call in
 * it returns an error (the error's rpcCode is the JSON-RPC error code).
 * @param {string} url
 * @param {Array<[string, Array]>} calls - [method, params] pairs
 */
async function rpcBatch(url, calls) {
  const results = [];
  let i = 0;
  while (i < calls.length) {
    const size = batchSizes.get(url) || BATCH_SIZE;
    const chunk = calls.slice(i, i + size);
    try {
      results.push(...await sendBatch(url, chunk));
      i += chunk.length;
    } catch (error) {
      if (!error.batchTooLarge) throw error;
      const smaller = Math.max(MIN_BATCH_SIZE, Math.floor(chunk.length / 2));
      logger.info(`[RPC Metrics] ${url} rejected a batch of ${chunk.length}; using ${smaller}`);
      batchSizes.set(url, smaller);
    }
  }
  return results;
}

async function getHead(url) {
  const [blockNumber] = await rpcBatch(url, [['eth_blockNumber', []]]);
  // A lagging node would make the days since its head look like 0-tx days.
  // Avalanche's coreth RPCs don't implement eth_syncing; go on without it.
  try {
    const [syncing] = await rpcBatch(url, [['eth_syncing', []]]);
    if (syncing !== false) {
      throw new Error('RPC node is syncing');
    }
  } catch (error) {
    if (!isUnsupported(error)) throw error;
  }
  return parseInt(blockNumber, 16);
}

async function getBlocks(url, numbers) {
  const results = await rpcBatch(url, numbers.map(n => ['eth_getBlockByNumber', [toHex(n), false]]));
  return results.map((block, i) => {
    if (!block) {
      throw new Error(`block ${numbers[i]} not found`);
    }
    return {
      number: numbers[i],
      timestamp: parseInt(block.timestamp, 16),
      txHashes: block.transactions,
      txCount: block.transactions.length,
      gasUsed: parseInt(block.gasUsed, 16)
    };
  });
}

function sumReceipts(block, receipts) {
  if (!Array.isArray(receipts) || receipts.length !== block.txCount) {
    throw new Error(`receipts for block ${block.number} don't match its transactions`);
  }
  let feesWei = 0n;
  let priceSumWei = 0n;
  for (const receipt of receipts) {
    if (!receipt || !receipt.effectiveGasPrice) {
      throw new Error(`receipt in block ${block.number} has no effectiveGasPrice`);
    }
    const price = BigInt(receipt.effectiveGasPrice);
    feesWei += BigInt(receipt.gasUsed) * price;
    priceSumWei += price;
  }
  return { feesWei, priceSumWei, txs: receipts.length };
}

/**
 * Fee totals for each block with transactions. `source` is how to get the
 * receipts: 'block' (eth_getBlockReceipts) or 'tx' (eth_getTransactionReceipt).
 * Returns null if the RPC doesn't support that method.
 * @returns {Promise<Map<number, { feesWei: bigint, priceSumWei: bigint, txs: number }>|null>}
 */
async function getBlockFees(url, blocks, source) {
  const withTxs = blocks.filter(b => b.txCount > 0);
  const fees = new Map();
  if (withTxs.length === 0) return fees;

  try {
    if (source === 'block') {
      const results = await rpcBatch(url, withTxs.map(b => ['eth_getBlockReceipts', [toHex(b.number)]]));
      results.forEach((receipts, i) => fees.set(withTxs[i].number, sumReceipts(withTxs[i], receipts)));
    } else {
      const calls = withTxs.flatMap(b => b.txHashes.map(hash => ['eth_getTransactionReceipt', [hash]]));
      const results = await rpcBatch(url, calls);
      let i = 0;
      for (const block of withTxs) {
        fees.set(block.number, sumReceipts(block, results.slice(i, i + block.txCount)));
        i += block.txCount;
      }
    }
  } catch (error) {
    if (isUnsupported(error)) return null;
    throw error;
  }
  return fees;
}

// Binary search for the first block with timestamp >= ts; head + 1 if none.
async function findFirstBlockAtOrAfter(url, ts, head) {
  let lo = 0;
  let hi = head + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const [block] = await getBlocks(url, [mid]);
    if (block.timestamp >= ts) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

// The metric rows for one counted day.
function dayRows(day) {
  const rows = [
    [TxCount, day.tx],
    [GasUsed, day.gas],
    [MaxTps, day.maxTps]
  ];
  if (day.withFees) {
    rows.push([FeesPaid, day.fees]);
    // No average for a day without transactions (not a 0 gas price).
    if (day.priceTxs > 0) {
      rows.push([AvgGasPrice, day.priceSum / day.priceTxs]);
    }
  }
  return rows;
}

// Add one block to a day's totals. `prevTimestamp` is its parent's timestamp
// (null if unknown); `fees` is the block's fee totals, if fetched.
function addBlock(totals, block, prevTimestamp, fees) {
  const seconds = prevTimestamp === null ? 1 : Math.max(1, block.timestamp - prevTimestamp);
  totals.maxTps = Math.max(totals.maxTps, block.txCount / seconds);
  totals.tx += block.txCount;
  totals.gas += block.gasUsed;
  if (totals.withFees && fees) {
    totals.fees += Number(fees.feesWei) / WEI_PER_TOKEN;
    totals.priceSum += Number(fees.priceSumWei) / WEI_PER_GWEI;
    totals.priceTxs += fees.txs;
  }
}

async function blockTimestamp(url, number) {
  return number >= 0 ? (await getBlocks(url, [number]))[0].timestamp : null;
}

/**
 * Count one chain's blocks and store the completed days, newest first: live
 * counting starts at yesterday's first block and keeps up with the head; time
 * left in a run goes to older days, one whole day at a time, back to
 * BACKFILL_DAYS ago.
 * @param {string} chainId
 * @param {string} rpcUrl
 * @param {{ maxBlocks?: number, now?: number, deadline?: number }} [options]
 *   maxBlocks: blocks counted per run; deadline: epoch ms after which the
 *   chain stops at the next batch
 */
async function updateChain(chainId, rpcUrl, {
  maxBlocks = MAX_BLOCKS_PER_RUN,
  now = Math.floor(Date.now() / 1000),
  deadline = Date.now() + RUN_BUDGET_MS
} = {}) {
  const today = dayStart(now);
  const yesterday = today - DAY_SECONDS;
  const saved = (await RpcTxCountState.findOne({ chainId }).lean()) || {};
  const state = saved.version === STATE_VERSION || saved.version === 2 ? saved : {};
  // feeSource: 'block' or 'tx' (how receipts are fetched), 'none' if neither
  // works; unset until the first block with transactions.
  let { lastBlock, lastTimestamp, dayTimestamp, day, feeSource, backfill = null } = state;
  let blocksCounted = 0;
  let daysWritten = 0;
  const pending = new Map(); // day timestamp -> day totals
  let lastSave = Date.now();
  const hasTime = () => Date.now() < deadline && blocksCounted < maxBlocks;

  // Finish the current day (and any days without blocks before `nextDay`).
  const closeDaysBefore = (nextDay) => {
    pending.set(dayTimestamp, day);
    for (let d = dayTimestamp + DAY_SECONDS; d < nextDay; d += DAY_SECONDS) {
      pending.set(d, newDay(feeSource !== 'none'));
    }
    dayTimestamp = nextDay;
    day = newDay(feeSource !== 'none');
  };

  const flush = async (lastError = null) => {
    if (pending.size > 0) {
      const opsByModel = new Map();
      for (const [timestamp, totals] of pending) {
        for (const [model, value] of dayRows(totals)) {
          if (!opsByModel.has(model)) opsByModel.set(model, []);
          opsByModel.get(model).push({
            updateOne: {
              filter: { chainId, timestamp },
              update: { $set: { value, source: 'rpc', lastUpdated: new Date() } },
              upsert: true
            }
          });
        }
      }
      await Promise.all([...opsByModel].map(([model, ops]) => model.bulkWrite(ops, { ordered: false })));
      daysWritten += pending.size;
      pending.clear();
    }
    lastSave = Date.now();
    await RpcTxCountState.updateOne(
      { chainId },
      {
        $set: {
          version: STATE_VERSION,
          lastBlock,
          lastTimestamp,
          dayTimestamp,
          day,
          backfill,
          feeSource,
          lastError,
          lastRunAt: new Date()
        }
      },
      { upsert: true }
    );
  };
  const saveIfDue = async () => {
    if (pending.size > 0 || Date.now() - lastSave >= SAVE_INTERVAL_MS) {
      await flush();
    }
  };

  // Fees for a batch of blocks, trying block receipts, then per-transaction
  // receipts, and remembering what works. null once neither does.
  const batchFees = async (blocks) => {
    for (const source of feeSource ? [feeSource] : ['block', 'tx']) {
      if (source === 'none') return null;
      const fees = await getBlockFees(rpcUrl, blocks, source);
      if (fees === null) continue;
      if (fees.size > 0) feeSource = source;
      return fees;
    }
    logger.info(`[RPC Metrics] Chain ${chainId}: RPC returns no receipts; skipping fees and gas price`);
    feeSource = 'none';
    day.withFees = false;
    if (backfill && backfill.totals) backfill.totals.withFees = false;
    return null;
  };

  // The next step of blocks from `from` up to `to`, with their fees.
  const nextStep = async (from, to) => {
    const numbers = [];
    for (let n = from; n <= Math.min(from + BLOCKS_PER_STEP - 1, to, from + maxBlocks - blocksCounted - 1); n++) {
      numbers.push(n);
    }
    const blocks = await getBlocks(rpcUrl, numbers);
    const fees = await batchFees(blocks);
    blocksCounted += blocks.length;
    return blocks.map(block => [block, fees && fees.get(block.number)]);
  };

  try {
    const head = await getHead(rpcUrl);

    // A new chain, or a state from before newest-first counting: start live
    // counting at yesterday. A version-2 state that is behind keeps the days
    // it wrote; the backfill redoes its unfinished day and the ones after it.
    if (state.version !== STATE_VERSION && !(state.version === 2 && dayTimestamp >= yesterday)) {
      const floor = state.version === 2 ? dayTimestamp : today - BACKFILL_DAYS * DAY_SECONDS;
      const start = await findFirstBlockAtOrAfter(rpcUrl, yesterday, head);
      lastBlock = start - 1;
      lastTimestamp = await blockTimestamp(rpcUrl, lastBlock);
      dayTimestamp = yesterday;
      day = newDay(feeSource !== 'none');
      backfill = yesterday - DAY_SECONDS >= floor
        ? { day: yesterday - DAY_SECONDS, floor, endBlock: start - 1 }
        : null;
    }

    // Live: from the last counted block towards the head.
    while (lastBlock < head && hasTime()) {
      for (const [block, fees] of await nextStep(lastBlock + 1, head)) {
        const blockDay = dayStart(block.timestamp);
        if (blockDay > dayTimestamp) {
          closeDaysBefore(blockDay);
        }
        addBlock(day, block, lastTimestamp, fees);
        lastBlock = block.number;
        lastTimestamp = block.timestamp;
      }
      await saveIfDue();
    }
    const caughtUp = lastBlock === head;

    // At the head every past day is complete, including days with no blocks.
    // Also store today's running totals, like the metrics API's in-progress bucket.
    if (caughtUp) {
      if (today > dayTimestamp) {
        closeDaysBefore(today);
      }
      pending.set(today, day);
      await flush();
    }

    // Older days, newest first, each written once all its blocks are counted.
    while (caughtUp && backfill && hasTime()) {
      if (backfill.nextBlock == null) {
        const first = await findFirstBlockAtOrAfter(rpcUrl, backfill.day, backfill.endBlock);
        backfill = {
          ...backfill,
          startBlock: first,
          nextBlock: first,
          prevTimestamp: await blockTimestamp(rpcUrl, first - 1),
          totals: newDay(feeSource !== 'none')
        };
      }
      while (backfill.nextBlock <= backfill.endBlock && hasTime()) {
        for (const [block, fees] of await nextStep(backfill.nextBlock, backfill.endBlock)) {
          addBlock(backfill.totals, block, backfill.prevTimestamp, fees);
          backfill.nextBlock = block.number + 1;
          backfill.prevTimestamp = block.timestamp;
        }
        await saveIfDue();
      }
      if (backfill.nextBlock > backfill.endBlock) {
        pending.set(backfill.day, backfill.totals);
        const older = backfill.day - DAY_SECONDS;
        backfill = older >= backfill.floor
          ? { day: older, floor: backfill.floor, endBlock: backfill.startBlock - 1 }
          : null;
        await flush();
      }
    }
    await flush();

    logger.info(`[RPC Metrics] Chain ${chainId}: counted ${blocksCounted} blocks, wrote ${daysWritten} days`, {
      lastBlock,
      head,
      feeSource,
      caughtUp,
      backfillDay: backfill ? new Date(backfill.day * 1000).toISOString().slice(0, 10) : 'done'
    });
    return { success: true, chainId, blocksCounted, daysWritten, caughtUp };
  } catch (error) {
    logger.warn(`[RPC Metrics] Chain ${chainId} stopped after ${blocksCounted} blocks: ${error.message}`);
    try {
      pending.delete(today); // only complete days survive a failure
      await flush(error.message);
    } catch (saveError) {
      logger.error(`[RPC Metrics] Chain ${chainId}: could not save progress: ${saveError.message}`);
    }
    return { success: false, chainId, blocksCounted, daysWritten, error: error.message };
  }
}

/**
 * Update every chain the metrics API returned 404 for (each has an
 * RpcTxCountState row, created by tpsService.syncDerivedTps), then re-derive
 * their TPS. Skips if a previous run is still going. Chains run least recently
 * updated first, so ones a run's deadline cut off go first next time.
 */
async function updateAllChains(options = {}) {
  if (running) {
    logger.info('[RPC Metrics] Previous run still in progress, skipping');
    return { skipped: true };
  }
  running = true;
  try {
    const tpsService = require('./tpsService');
    const { deadline = Date.now() + RUN_BUDGET_MS, ...chainOptions } = options;
    const states = await RpcTxCountState.find().select('chainId lastRunAt').sort({ lastRunAt: 1 }).lean();
    const chainsById = new Map(
      (await Chain.find({ evmChainId: { $in: states.map(s => Number(s.chainId)) } })
        .select('evmChainId chainName rpcUrl rpcUrls')
        .lean())
        .map(chain => [String(chain.evmChainId), chain])
    );
    const chains = states.map(s => chainsById.get(s.chainId)).filter(Boolean);

    const limit = pLimit(CHAIN_CONCURRENCY);
    const results = await Promise.all(chains.map(chain => limit(async () => {
      const chainId = String(chain.evmChainId);
      if (Date.now() >= deadline) {
        return { success: false, chainId, error: 'run deadline reached' };
      }
      const rpcUrl = chain.rpcUrl || (chain.rpcUrls || [])[0];
      if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) {
        return { success: false, chainId, error: 'no RPC URL' };
      }
      const result = await updateChain(chainId, rpcUrl, { ...chainOptions, deadline });
      if (result.daysWritten > 0) {
        await tpsService.updateTpsData(chainId);
      }
      return result;
    })));

    const succeeded = results.filter(r => r.success).length;
    const deferred = results.filter(r => r.error === 'run deadline reached').length;
    logger.info(`[RPC Metrics] Run done: ${succeeded} of ${results.length} chains updated, ${deferred} left for the next run`);
    return { success: true, chains: results.length, succeeded };
  } finally {
    running = false;
  }
}

module.exports = { updateChain, updateAllChains };
