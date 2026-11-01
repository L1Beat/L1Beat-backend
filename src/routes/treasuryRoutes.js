const express = require('express');
const router = express.Router();
const treasuryService = require('../services/treasuryService');
const cacheManager = require('../utils/cacheManager');
const logger = require('../utils/logger');
const { validate, validators } = require('../utils/validationMiddleware');

// Short, so the first update after a restart shows up within a minute.
const TTL = 60 * 1000;

// Cached JSON route: `load(req)` builds the body, kept for TTL under `key(req)`.
function cachedRoute(key, load) {
  return async (req, res) => {
    try {
      const cacheKey = key(req);
      const cached = cacheManager.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const body = { success: true, ...(await load(req)) };
      cacheManager.set(cacheKey, body, TTL);
      res.json(body);
    } catch (error) {
      logger.error('Treasuries Error:', { path: req.path, error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  };
}

// Companies and ETFs holding AVAX, with totals and the AVAX price and
// circulating supply.
router.get('/treasuries', cachedRoute(
  () => 'treasuries:latest',
  () => treasuryService.getLatest()
));

// Daily snapshots per holder, newest first; ?days=1-365, default 30.
// History starts on the day the endpoint went live.
router.get('/treasuries/history', validate(validators.getTreasuriesHistory), cachedRoute(
  req => `treasuries:history:${req.query.days || 30}`,
  async req => {
    const days = req.query.days || 30;
    return { days, holders: await treasuryService.getHistory(days) };
  }
));

module.exports = router;
