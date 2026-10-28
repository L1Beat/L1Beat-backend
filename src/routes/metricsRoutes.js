const express = require('express');
const router = express.Router();
const txCountService = require('../services/txCountService');
const maxTpsService = require('../services/maxTpsService');
const activeAddressesService = require('../services/activeAddressesService');
const gasUsedService = require('../services/gasUsedService');
const feesPaidService = require('../services/feesPaidService');
const avgGasPriceService = require('../services/avgGasPriceService');
const logger = require('../utils/logger');
const { validate, validators } = require('../utils/validationMiddleware');

const HISTORY = {
  txCount: txCountService.getTxCountHistory,
  maxTps: maxTpsService.getMaxTpsHistory,
  activeAddresses: activeAddressesService.getActiveAddressesHistory,
  gasUsed: gasUsedService.getGasUsedHistory,
  feesPaid: feesPaidService.getFeesPaidHistory,
  avgGasPrice: avgGasPriceService.getAvgGasPriceHistory
};

// Get several metrics' history for a chain in one call, e.g.
// ?days=30&metrics=txCount,gasUsed. Each array has the same rows as that
// metric's own /chains/:chainId/<metric>/history route. Without `metrics`,
// all of them are returned.
router.get('/chains/:chainId/metrics/history', validate(validators.getMetricsHistory), async (req, res) => {
  try {
    const { chainId } = req.params;
    const days = req.query.days || 30;
    const metrics = req.query.metrics
      ? [...new Set(String(req.query.metrics).split(',').map(m => m.trim()).filter(Boolean))]
      : Object.keys(HISTORY);

    const unknown = metrics.filter(m => !Object.hasOwn(HISTORY, m));
    if (unknown.length > 0 || metrics.length === 0) {
      return res.status(400).json({
        success: false,
        error: `Unknown metrics: ${unknown.join(', ') || '(none)'}. Valid: ${Object.keys(HISTORY).join(', ')}`
      });
    }

    const series = await Promise.all(metrics.map(m => HISTORY[m](chainId, days)));
    res.json({
      success: true,
      chainId,
      days,
      data: Object.fromEntries(metrics.map((m, i) => [m, series[i]]))
    });
  } catch (error) {
    logger.error('Metrics History Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
