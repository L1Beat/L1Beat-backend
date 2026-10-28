const axios = require('axios');
const pLimit = require('p-limit');
const TxCount = require('../models/txCount');
const RpcTxCountState = require('../models/rpcTxCountState');
const Chain = require('../models/chain');
const logger = require('../utils/logger');

// Daily txCount for chains the metrics API doesn't cover (it returns 404),
// counted from the chain's own public RPC and stored in the same TxCount
// collection with source 'rpc'. TPS derivation and the tx-count routes then
// work unchanged.
//
// Each run walks only the blocks after the last one counted (kept in
// RpcTxCountState) and writes a UTC day once all of its blocks are counted.
// A failed RPC stops that chain's run at the last complete batch, so a day is
// never written from a partial count: it stays missing (null) instead of 0.

const DAY_SECONDS = 24 * 60 * 60;
const BACKFILL_DAYS = 30;
const BATCH_SIZE = 100;
// Third-party RPCs: few requests at a time, and a cap per run so a busy chain's
// 30-day backfill spreads over several hourly runs instead of one long one.
const MAX_BLOCKS_PER_RUN = 250000;
const CHAIN_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 20000;
const RETRIES = 3;

const dayStart = (ts) => ts - (ts % DAY_SECONDS);
const toHex = (n) => '0x' + n.toString(16);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let running = false;

/**
 * Send a JSON-RPC batch and return the results in call order. Throws if the
 * batch fails after retries or any call in it returns an error.
 * @param {string} url
 * @param {Array<[string, Array]>} calls - [method, params] pairs
 */
async function rpcBatch(url, calls) {
  const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
  for (let attempt = 1; ; attempt++) {
    try {
      const { data } = await axios.post(url, body, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' }
      });
      if (!Array.isArray(data)) {
        throw new Error('RPC did not return a batch response');
      }
      const byId = new Map(data.map(r => [r.id, r]));
      return calls.map((call, id) => {
        const r = byId.get(id);
        if (!r || r.error || r.result === undefined) {
          throw new Error(`${call[0]} failed: ${r && r.error ? r.error.message : 'missing result'}`);
        }
        return r.result;
      });
    } catch (error) {
      if (attempt >= RETRIES) throw error;
      await sleep(2000 * attempt);
    }
  }
}

async function getHead(url) {
  const [blockNumber, syncing] = await rpcBatch(url, [['eth_blockNumber', []], ['eth_syncing', []]]);
  // A lagging node would make the days since its head look like 0-tx days.
  if (syncing !== false) {
    throw new Error('RPC node is syncing');
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
      txCount: block.transactions.length
    };
  });
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

/**
 * Count new blocks for one chain and store the completed days.
 * @param {string} chainId
 * @param {string} rpcUrl
 * @param {{ maxBlocks?: number, now?: number }} [options]
 */
async function updateChain(chainId, rpcUrl, { maxBlocks = MAX_BLOCKS_PER_RUN, now = Math.floor(Date.now() / 1000) } = {}) {
  const today = dayStart(now);
  const state = (await RpcTxCountState.findOne({ chainId }).lean()) || {};
  let { lastBlock, dayTimestamp, dayCount } = state;
  let blocksCounted = 0;
  let daysWritten = 0;
  const pending = new Map(); // day timestamp -> tx count

  // Finish the current day (and any days without blocks before `day`).
  const closeDaysBefore = (day) => {
    pending.set(dayTimestamp, dayCount);
    for (let d = dayTimestamp + DAY_SECONDS; d < day; d += DAY_SECONDS) {
      pending.set(d, 0);
    }
    dayTimestamp = day;
    dayCount = 0;
  };

  const flush = async (lastError = null) => {
    if (pending.size > 0) {
      await TxCount.bulkWrite([...pending].map(([timestamp, value]) => ({
        updateOne: {
          filter: { chainId, timestamp },
          update: { $set: { value, source: 'rpc', lastUpdated: new Date() } },
          upsert: true
        }
      })), { ordered: false });
      daysWritten += pending.size;
      pending.clear();
    }
    await RpcTxCountState.updateOne(
      { chainId },
      { $set: { lastBlock, dayTimestamp, dayCount, lastError, lastRunAt: new Date() } },
      { upsert: true }
    );
  };

  try {
    const head = await getHead(rpcUrl);

    if (lastBlock === undefined || lastBlock === null) {
      const start = today - BACKFILL_DAYS * DAY_SECONDS;
      lastBlock = (await findFirstBlockAtOrAfter(rpcUrl, start, head)) - 1;
      dayTimestamp = start;
      dayCount = 0;
    }

    const end = Math.min(head, lastBlock + maxBlocks);
    for (let from = lastBlock + 1; from <= end; from += BATCH_SIZE) {
      const numbers = [];
      for (let n = from; n <= Math.min(from + BATCH_SIZE - 1, end); n++) numbers.push(n);

      const blocks = await getBlocks(rpcUrl, numbers);
      for (const block of blocks) {
        const day = dayStart(block.timestamp);
        if (day > dayTimestamp) {
          closeDaysBefore(day);
        }
        dayCount += block.txCount;
        lastBlock = block.number;
        blocksCounted++;
      }
      if (pending.size > 0) {
        await flush();
      }
    }

    // At the head every past day is complete, including days with no blocks.
    // Also store today's running count, like the metrics API's in-progress bucket.
    if (end === head) {
      if (today > dayTimestamp) {
        closeDaysBefore(today);
      }
      pending.set(today, dayCount);
    }
    await flush();

    logger.info(`[RPC TxCount] Chain ${chainId}: counted ${blocksCounted} blocks, wrote ${daysWritten} days`, {
      lastBlock,
      head,
      caughtUp: end === head
    });
    return { success: true, chainId, blocksCounted, daysWritten, caughtUp: end === head };
  } catch (error) {
    logger.warn(`[RPC TxCount] Chain ${chainId} stopped after ${blocksCounted} blocks: ${error.message}`);
    try {
      pending.delete(today); // only complete days survive a failure
      await flush(error.message);
    } catch (saveError) {
      logger.error(`[RPC TxCount] Chain ${chainId}: could not save progress: ${saveError.message}`);
    }
    return { success: false, chainId, blocksCounted, daysWritten, error: error.message };
  }
}

/**
 * Update every chain the metrics API returned 404 for (each has an
 * RpcTxCountState row, created by tpsService.syncDerivedTps), then re-derive
 * their TPS. Skips if a previous run is still going.
 */
async function updateAllChains(options = {}) {
  if (running) {
    logger.info('[RPC TxCount] Previous run still in progress, skipping');
    return { skipped: true };
  }
  running = true;
  try {
    const tpsService = require('./tpsService');
    const states = await RpcTxCountState.find().select('chainId').lean();
    const chains = await Chain.find({ evmChainId: { $in: states.map(s => Number(s.chainId)) } })
      .select('evmChainId chainName rpcUrl rpcUrls')
      .lean();

    const limit = pLimit(CHAIN_CONCURRENCY);
    const results = await Promise.all(chains.map(chain => limit(async () => {
      const chainId = String(chain.evmChainId);
      const rpcUrl = chain.rpcUrl || (chain.rpcUrls || [])[0];
      if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) {
        return { success: false, chainId, error: 'no RPC URL' };
      }
      const result = await updateChain(chainId, rpcUrl, options);
      if (result.daysWritten > 0) {
        await tpsService.updateTpsData(chainId);
      }
      return result;
    })));

    const succeeded = results.filter(r => r.success).length;
    logger.info(`[RPC TxCount] Run done: ${succeeded} of ${results.length} chains updated`);
    return { success: true, chains: results.length, succeeded };
  } finally {
    running = false;
  }
}

module.exports = { updateChain, updateAllChains };
