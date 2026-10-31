const Chain = require('../models/chain');
const cacheManager = require('./cacheManager');
const logger = require('./logger');

const DAY_SECONDS = 24 * 60 * 60;
const TTL = 60 * 1000;

// Route handler returning one daily metric's latest complete day for all
// chains in a single call: [{ evmChainId, subnetId, chainName, [field]:
// { value, previous, timestamp } | null }].
// Today's in-progress bucket is skipped, so quiet chains don't read as 0.
// The metrics API stores days with no activity as explicit 0 rows, so a
// missing row means "not indexed" and is returned as null, not 0.
function allLatestHandler(model, field) {
  const cacheKey = `${field}:all:latest`;

  return async (req, res) => {
    try {
      const cached = cacheManager.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const chains = await Chain.find({
        evmChainId: { $exists: true, $ne: null }
      }).select('evmChainId chainName subnetId').lean();

      const now = Math.floor(Date.now() / 1000);
      const latestDay = now - (now % DAY_SECONDS) - DAY_SECONDS;
      const previousDay = latestDay - DAY_SECONDS;

      const records = await model.find({
        chainId: { $in: chains.map(c => String(c.evmChainId)) },
        timestamp: { $in: [latestDay, previousDay] }
      }).select('chainId timestamp value').lean();

      const byKey = new Map(records.map(r => [`${r.chainId}:${r.timestamp}`, Number(r.value)]));

      const data = chains.map(chain => {
        const id = String(chain.evmChainId);
        const value = byKey.get(`${id}:${latestDay}`);
        const previous = byKey.get(`${id}:${previousDay}`);
        return {
          evmChainId: chain.evmChainId,
          subnetId: chain.subnetId,
          chainName: chain.chainName,
          [field]: value === undefined ? null : {
            value,
            previous: previous === undefined ? null : previous,
            timestamp: latestDay
          }
        };
      });

      const body = { success: true, count: data.length, data };
      cacheManager.set(cacheKey, body, TTL);
      res.json(body);
    } catch (error) {
      logger.error('All Latest Error:', { field, error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  };
}

module.exports = allLatestHandler;
