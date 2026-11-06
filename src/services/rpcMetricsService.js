const axios = require('axios');
const pLimit = require('p-limit');
const TxCount = require('../models/txCount');
const GasUsed = require('../models/gasUsed');
const MaxTps = require('../models/maxTps');
const FeesPaid = require('../models/feesPaid');
const AvgGasPrice = require('../models/avgGasPrice');
const ActiveAddresses = require('../models/activeAddresses');
const RpcDayAddresses = require('../models/rpcDayAddresses');
const RpcTxCountState = require('../models/rpcTxCountState');
const Chain = require('../models/chain');
const logger = require('../utils/logger');
const tpsService = require('./tpsService');

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
//   activeAddresses  distinct addresses in the from and to of a transaction
//                or of an ERC20/ERC721/ERC1155 transfer log (the metrics API's
//                stated definition). The metrics API also counts addresses
//                only traces show (internal calls), which public RPCs don't
//                serve, so these counts run lower than its numbers.
// Fees, gas price and addresses come from receipts: eth_getBlockReceipts where the RPC
// has it, else one eth_getTransactionReceipt per transaction (Avalanche's
// public subnets.avax.network RPCs). Base fee * gas is not used: tips are a
// large share of fees on these chains.
//
// Newest days first: live counting starts at yesterday and keeps up with the
// head; leftover time in a run counts older days back to BACKFILL_DAYS, or to
// the chain's first block if it is younger: days before it get no rows. Progress
// is kept in RpcTxCountState and a UTC day is written once all of its blocks
// are counted. A day's addresses seen so far are kept in RpcDayAddresses, so
// a day counted across several runs still counts each address once.
// A failed RPC stops that chain's run at the last complete batch, so a day is
// never written from a partial count: it stays missing (null) instead of 0.

const DAY_SECONDS = 24 * 60 * 60;
const BACKFILL_DAYS = 365;
// The depth states saved before `backfillDays` was recorded were set up for.
// A state set up for less than BACKFILL_DAYS is extended once.
const LEGACY_BACKFILL_DAYS = 30;
const BLOCKS_PER_STEP = 100;
// Calls per JSON-RPC batch. Halved for an RPC that rejects a batch as too
// large (subnets.avax.network fails above ~40), down to MIN_BATCH_SIZE, and
// doubled again after GROW_AFTER batches in a row succeed, so a few transient
// errors don't leave an RPC at tiny batches (many more requests) for good.
const BATCH_SIZE = 100;
const MIN_BATCH_SIZE = 5;
const GROW_AFTER = 50;
// Third-party RPCs: few requests at a time, and a cap per run so a busy chain's
// backfill spreads over many hourly runs instead of one long one.
const MAX_BLOCKS_PER_RUN = 250000;
// A run stops by this deadline so it ends before the next hourly run starts;
// chains pick up where they stopped. Progress is saved at least this often, so
// a restart mid-run loses little.
const RUN_BUDGET_MS = 45 * 60 * 1000;
const SAVE_INTERVAL_MS = 60 * 1000;
const CHAIN_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 20000;
const RETRIES = 3;
// Rate limited (HTTP 429): wait as the RPC asks (Retry-After) or back off,
// up to this many times per batch, instead of giving up on the chain.
const RATE_LIMIT_RETRIES = 8;
const MAX_BACKOFF_MS = 60 * 1000;
// Bump when the counted metrics change: older states restart counting at
// yesterday and backfill again, so every day gets the new metrics. Version 4
// added activeAddresses.
const STATE_VERSION = 4;
// Token transfer events whose from and to count as active addresses:
// ERC20/ERC721 Transfer (from, to in topics 1-2), ERC1155 TransferSingle and
// TransferBatch (from, to in topics 2-3; topic 1 is the operator).
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const TRANSFER_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
// Addresses per RpcDayAddresses row (20 bytes each, well under Mongo's 16 MB).
const ADDRESSES_PER_ROW = 100000;
const WEI_PER_GWEI = 1e9;
const WEI_PER_TOKEN = 1e18;

const dayStart = (ts) => ts - (ts % DAY_SECONDS);
const toHex = (n) => '0x' + n.toString(16);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const newDay = (withFees) => ({ tx: 0, gas: 0, maxTps: 0, fees: 0, priceSum: 0, priceTxs: 0, withFees });

let running = false;
const batchSizes = new Map(); // rpc url -> { size, ok: batches in a row that succeeded }

// The RPC doesn't offer this method; retrying won't help.
const isUnsupported = (error) =>
  error.rpcCode === -32601 || /not (found|supported|available|implemented)|does not exist/i.test(error.message);

// How long a 429 response asks to wait, if it says (Retry-After in seconds).
function retryAfterMs(error) {
  const header = error.response && error.response.headers && error.response.headers['retry-after'];
  const seconds = Number(header);
  return header !== undefined && Number.isFinite(seconds) ? Math.min(MAX_BACKOFF_MS, seconds * 1000) : null;
}

// Send one JSON-RPC batch, with retries. Results are in call order.
async function sendBatch(url, calls) {
  const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
  let rateLimited = 0;
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
        error.rateLimited = status === 429;
        if (calls.length > MIN_BATCH_SIZE) {
          // 413 says so outright. A 5xx may also be a passing failure, so it
          // only counts as "too large" if it persists through the retries.
          error.batchTooLarge = status === 413;
          error.maybeTooLarge = status >= 500;
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
      if (error.rateLimited && rateLimited < RATE_LIMIT_RETRIES) {
        rateLimited++;
        attempt--; // waiting out a rate limit isn't a failed attempt
        await sleep(retryAfterMs(error) ?? Math.min(MAX_BACKOFF_MS, 5000 * 2 ** (rateLimited - 1)));
        continue;
      }
      if (error.batchTooLarge || isUnsupported(error)) throw error;
      if (attempt >= RETRIES) {
        error.batchTooLarge = Boolean(error.maybeTooLarge);
        throw error;
      }
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
    const batch = batchSizes.get(url) || { size: BATCH_SIZE, ok: 0 };
    batchSizes.set(url, batch);
    const chunk = calls.slice(i, i + batch.size);
    try {
      results.push(...await sendBatch(url, chunk));
      i += chunk.length;
      if (batch.size < BATCH_SIZE && chunk.length === batch.size && ++batch.ok >= GROW_AFTER) {
        batch.size = Math.min(BATCH_SIZE, batch.size * 2);
        batch.ok = 0;
      }
    } catch (error) {
      if (!error.batchTooLarge) throw error;
      const smaller = Math.max(MIN_BATCH_SIZE, Math.floor(chunk.length / 2));
      logger.info(`[RPC Metrics] ${url} rejected a batch of ${chunk.length}; using ${smaller}`);
      batchSizes.set(url, { size: smaller, ok: 0 });
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

// An address as kept in address sets: lowercase hex without 0x. A topic holds
// an address in its last 20 bytes.
const addressKey = (hex) => hex.slice(-40).toLowerCase();

// Add the addresses a transaction makes active: its from and to, and the from
// and to of each token transfer it logs.
function addReceiptAddresses(receipt, addresses) {
  addresses.add(addressKey(receipt.from));
  if (receipt.to) addresses.add(addressKey(receipt.to));
  for (const { topics = [] } of receipt.logs || []) {
    const event = topics[0] && topics[0].toLowerCase();
    if (event === TRANSFER_TOPIC && topics.length >= 3) {
      addresses.add(addressKey(topics[1]));
      addresses.add(addressKey(topics[2]));
    } else if ((event === TRANSFER_SINGLE_TOPIC || event === TRANSFER_BATCH_TOPIC) && topics.length >= 4) {
      addresses.add(addressKey(topics[2]));
      addresses.add(addressKey(topics[3]));
    }
  }
}

function sumReceipts(block, receipts) {
  if (!Array.isArray(receipts) || receipts.length !== block.txCount) {
    throw new Error(`receipts for block ${block.number} don't match its transactions`);
  }
  let feesWei = 0n;
  let priceSumWei = 0n;
  const addresses = new Set();
  for (const receipt of receipts) {
    if (!receipt || !receipt.effectiveGasPrice) {
      throw new Error(`receipt in block ${block.number} has no effectiveGasPrice`);
    }
    if (!receipt.from) {
      throw new Error(`receipt in block ${block.number} has no from`);
    }
    const price = BigInt(receipt.effectiveGasPrice);
    feesWei += BigInt(receipt.gasUsed) * price;
    priceSumWei += price;
    addReceiptAddresses(receipt, addresses);
  }
  return { feesWei, priceSumWei, txs: receipts.length, addresses };
}

/**
 * Fee totals and active addresses for each block with transactions. `source` is how to get the
 * receipts: 'block' (eth_getBlockReceipts) or 'tx' (eth_getTransactionReceipt).
 * Returns null if the RPC doesn't support that method.
 * @returns {Promise<Map<number, { feesWei: bigint, priceSumWei: bigint, txs: number, addresses: Set<string> }>|null>}
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

// The metric rows for one counted day; `activeAddresses` is how many distinct
// addresses its blocks had.
function dayRows(day, activeAddresses) {
  const rows = [
    [TxCount, day.tx],
    [GasUsed, day.gas],
    [MaxTps, day.maxTps]
  ];
  // Fees and addresses both come from receipts: none without them.
  if (day.withFees) {
    rows.push([FeesPaid, day.fees]);
    rows.push([ActiveAddresses, activeAddresses]);
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

// A Buffer field as read with lean(): a BSON Binary.
const bytesOf = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value.buffer.subarray(0, value.position)));

async function blockTimestamp(url, number) {
  return number >= 0 ? (await getBlocks(url, [number]))[0].timestamp : null;
}

/**
 * Count one chain's blocks and store the completed days, newest first: live
 * counting starts at yesterday's first block and keeps up with the head; time
 * left in a run goes to older days, one whole day at a time, back to
 * BACKFILL_DAYS ago or the chain's first block.
 * @param {string} chainId
 * @param {string} rpcUrl
 * @param {{ maxBlocks?: number, now?: number, deadline?: number, liveOnly?: boolean }} [options]
 *   maxBlocks: blocks counted per run; deadline: epoch ms after which the
 *   chain stops at the next batch; liveOnly: stop at the head, leaving older
 *   days for a later call
 */
async function updateChain(chainId, rpcUrl, {
  maxBlocks = MAX_BLOCKS_PER_RUN,
  now = Math.floor(Date.now() / 1000),
  deadline = Date.now() + RUN_BUDGET_MS,
  liveOnly = false
} = {}) {
  const today = dayStart(now);
  const yesterday = today - DAY_SECONDS;
  const saved = (await RpcTxCountState.findOne({ chainId }).lean()) || {};
  // A state from an older version, or one whose first run never found
  // yesterday's first block, starts over.
  const state = saved.version === STATE_VERSION && saved.lastBlock != null ? saved : {};
  // feeSource: 'block' or 'tx' (how receipts are fetched), 'none' if neither
  // works; unset until the first block with transactions.
  let { lastBlock, lastTimestamp, dayTimestamp, day, feeSource, backfill = null } = state;
  let backfillDays = state.backfillDays ?? LEGACY_BACKFILL_DAYS;
  let blocksCounted = 0;
  let daysWritten = 0;
  const pending = new Map(); // day timestamp -> day totals
  let lastSave = Date.now();
  const hasTime = () => Date.now() < deadline && blocksCounted < maxBlocks;
  // Active addresses: for each day being counted, the addresses seen so far
  // (see addressKey), and those not yet saved to RpcDayAddresses.
  const addressSets = new Map(); // day timestamp -> Set
  const unsavedAddresses = new Map(); // day timestamp -> array
  const addAddresses = (timestamp, fees) => {
    if (!fees) return;
    if (!addressSets.has(timestamp)) addressSets.set(timestamp, new Set());
    const seen = addressSets.get(timestamp);
    for (const address of fees.addresses) {
      if (seen.has(address)) continue;
      seen.add(address);
      if (!unsavedAddresses.has(timestamp)) unsavedAddresses.set(timestamp, []);
      unsavedAddresses.get(timestamp).push(address);
    }
  };
  const loadAddresses = async (timestamp) => {
    const seen = new Set();
    for (const row of await RpcDayAddresses.find({ chainId, day: timestamp }).lean()) {
      const bytes = bytesOf(row.addresses);
      for (let i = 0; i + 20 <= bytes.length; i += 20) {
        seen.add(bytes.toString('hex', i, i + 20));
      }
    }
    addressSets.set(timestamp, seen);
  };
  // Days with some blocks counted but not all: the live day, and the
  // backfill's day once it has started.
  const openDays = () => [dayTimestamp, backfill && backfill.nextBlock != null ? backfill.day : null]
    .filter(timestamp => timestamp != null);

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
    // Addresses of days still open go first: the state saved below counts
    // their blocks as done. Days written now don't need theirs kept.
    const open = openDays();
    const rows = [];
    for (const [timestamp, addresses] of unsavedAddresses) {
      if (!open.includes(timestamp)) continue;
      for (let i = 0; i < addresses.length; i += ADDRESSES_PER_ROW) {
        const chunk = addresses.slice(i, i + ADDRESSES_PER_ROW);
        rows.push({ chainId, day: timestamp, addresses: Buffer.from(chunk.join(''), 'hex') });
      }
    }
    if (rows.length > 0) {
      await RpcDayAddresses.insertMany(rows, { ordered: false });
    }
    unsavedAddresses.clear();

    if (pending.size > 0) {
      const opsByModel = new Map();
      for (const [timestamp, totals] of pending) {
        const activeAddresses = addressSets.has(timestamp) ? addressSets.get(timestamp).size : 0;
        for (const [model, value] of dayRows(totals, activeAddresses)) {
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
      // TPS is derived from txCount; keep it in step as each day lands.
      await tpsService.updateTpsData(chainId);
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
          backfillDays,
          feeSource,
          lastError,
          lastRunAt: new Date()
        }
      },
      { upsert: true }
    );
    // Written days no longer need their addresses.
    for (const timestamp of addressSets.keys()) {
      if (!open.includes(timestamp)) addressSets.delete(timestamp);
    }
    await RpcDayAddresses.deleteMany({ chainId, day: { $nin: open } });
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

    // A new chain, or a state from an older version: start live counting at
    // yesterday, and backfill from the day before.
    if (state.version !== STATE_VERSION) {
      const floor = today - BACKFILL_DAYS * DAY_SECONDS;
      await RpcDayAddresses.deleteMany({ chainId });
      const start = await findFirstBlockAtOrAfter(rpcUrl, yesterday, head);
      lastBlock = start - 1;
      lastTimestamp = await blockTimestamp(rpcUrl, lastBlock);
      dayTimestamp = yesterday;
      day = newDay(feeSource !== 'none');
      backfill = yesterday - DAY_SECONDS >= floor
        ? { day: yesterday - DAY_SECONDS, floor, endBlock: start - 1 }
        : null;
      backfillDays = BACKFILL_DAYS;
    } else {
      // Resuming: the addresses already seen on the days left half counted.
      for (const timestamp of openDays()) {
        await loadAddresses(timestamp);
      }
    }

    // Set up for a shallower backfill: lower a running backfill's floor, or
    // start a new one below the oldest day the chain has rows for.
    if (backfillDays < BACKFILL_DAYS) {
      const floor = today - BACKFILL_DAYS * DAY_SECONDS;
      if (backfill) {
        backfill = { ...backfill, floor: Math.min(backfill.floor, floor) };
      } else {
        const oldest = await TxCount.findOne({ chainId }).sort({ timestamp: 1 }).select('timestamp').lean();
        const endBlock = oldest && oldest.timestamp - DAY_SECONDS >= floor
          ? (await findFirstBlockAtOrAfter(rpcUrl, oldest.timestamp, head)) - 1
          : 0;
        backfill = endBlock > 0 ? { day: oldest.timestamp - DAY_SECONDS, floor, endBlock } : null;
      }
      backfillDays = BACKFILL_DAYS;
    }

    // Live: from the last counted block towards the head.
    while (lastBlock < head && hasTime()) {
      for (const [block, fees] of await nextStep(lastBlock + 1, head)) {
        const blockDay = dayStart(block.timestamp);
        if (blockDay > dayTimestamp) {
          closeDaysBefore(blockDay);
        }
        addBlock(day, block, lastTimestamp, fees);
        addAddresses(dayTimestamp, fees);
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
    while (caughtUp && backfill && !liveOnly && hasTime()) {
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
          addAddresses(backfill.day, fees);
          backfill.nextBlock = block.number + 1;
          backfill.prevTimestamp = block.timestamp;
        }
        await saveIfDue();
      }
      if (backfill.nextBlock > backfill.endBlock) {
        pending.set(backfill.day, backfill.totals);
        const older = backfill.day - DAY_SECONDS;
        // At the chain's first blocks (block 0 is genesis) there is nothing older.
        backfill = older >= backfill.floor && backfill.startBlock > 1
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
    return { success: true, chainId, blocksCounted, daysWritten, caughtUp, backfilling: backfill != null };
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
 * RpcTxCountState row, created by tpsService.syncDerivedTps). Skips if a
 * previous run is still going. Chains run least recently updated first, so
 * ones a run's deadline cut off go first next time.
 *
 * Two passes share the run's deadline: first every chain catches up to its
 * head, then chains with older days left backfill. A long backfill can then
 * never hold up another chain's latest days.
 */
async function updateAllChains(options = {}) {
  if (running) {
    logger.info('[RPC Metrics] Previous run still in progress, skipping');
    return { skipped: true };
  }
  running = true;
  try {
    const { deadline = Date.now() + RUN_BUDGET_MS, ...chainOptions } = options;
    const states = await RpcTxCountState.find().select('chainId lastRunAt').sort({ lastRunAt: 1 }).lean();
    const chainsById = new Map(
      (await Chain.find({ evmChainId: { $in: states.map(s => Number(s.chainId)) } })
        .select('evmChainId chainName rpcUrl rpcUrls')
        .lean())
        .map(chain => [String(chain.evmChainId), chain])
    );
    const chains = states.map(s => chainsById.get(s.chainId)).filter(Boolean);

    // p-limit starts queued calls in order, and every live call is queued
    // before any backfill call, so backfills only take slots no live call
    // is waiting for.
    const limit = pLimit(CHAIN_CONCURRENCY);
    const update = (chain, liveOnly) => limit(async () => {
      const chainId = String(chain.evmChainId);
      if (Date.now() >= deadline) {
        return { success: false, chainId, error: 'run deadline reached' };
      }
      const rpcUrl = chain.rpcUrl || (chain.rpcUrls || [])[0];
      if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) {
        return { success: false, chainId, error: 'no RPC URL' };
      }
      return updateChain(chainId, rpcUrl, { ...chainOptions, deadline, liveOnly });
    });
    const backfills = [];
    const results = await Promise.all(chains.map(chain => update(chain, true).then(result => {
      if (result.success && result.caughtUp && result.backfilling) {
        backfills.push(update(chain, false));
      }
      return result;
    })));
    const backfillResults = await Promise.all(backfills);

    const succeeded = results.filter(r => r.success).length;
    const deferred = results.filter(r => r.error === 'run deadline reached').length;
    const backfilled = backfillResults.filter(r => r.success).length;
    logger.info(`[RPC Metrics] Run done: ${succeeded} of ${results.length} chains updated, ${deferred} left for the next run, ${backfilled} of ${backfills.length} backfilled`);
    return { success: true, chains: results.length, succeeded, backfilled };
  } finally {
    running = false;
  }
}

module.exports = { updateChain, updateAllChains };
