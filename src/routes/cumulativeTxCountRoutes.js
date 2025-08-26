const express = require('express');
const router = express.Router();
const tpsService = require('../services/tpsService');
const Chain = require('../models/chain');
const CumulativeTxCount = require('../models/cumulativeTxCount');
const { validate, validators } = require('../utils/validationMiddleware');
const logger = require('../utils/logger');
const config = require('../config/config');

// Get transaction count history for a chain
router.get('/chains/:chainId/cumulativeTxCount/history', validate(validators.getChainIdParam), async (req, res) => {
  try {
    const { chainId } = req.params;
    const days = parseInt(req.query.days) || 30;
    
    const data = await tpsService.getTxCountHistory(chainId, days);
    res.json({
      success: true,
      chainId,
      count: data.length,
      data
    });
  } catch (error) {
    logger.error('CumulativeTxCount History Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get latest transaction count for a chain
router.get('/chains/:chainId/cumulativeTxCount/latest', validate(validators.getChainIdParam), async (req, res) => {
  try {
    const { chainId } = req.params;
    
    const data = await tpsService.getLatestTxCount(chainId);
    res.json({
      success: true,
      chainId,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Latest CumulativeTxCount Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check endpoint
router.get('/cumulativeTxCount/health', async (req, res) => {
  try {
    const chains = await Chain.find().select('chainId').lean();
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const txCounts = await CumulativeTxCount.find({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    })
      .sort({ timestamp: -1 })
      .lean();

    const chainTxCountStats = await CumulativeTxCount.aggregate([
      {
        $match: {
          timestamp: { $gte: oneDayAgo, $lte: currentTime }
        }
      },
      {
        $group: {
          _id: '$chainId',
          count: { $sum: 1 },
          lastUpdate: { $max: '$timestamp' }
        }
      }
    ]);
        
    res.json({
      success: true,
      stats: {
        totalChains: chains.length,
        chainIds: chains.map(c => c.chainId),
        recentCumulativeTxCountRecords: txCounts.length,
        lastCumulativeTxCountUpdate: txCounts[0] ? new Date(txCounts[0].timestamp * 1000).toISOString() : null,
        environment: config.env,
        chainsWithCumulativeTxCount: chainTxCountStats.length,
        chainCumulativeTxCountDetails: chainTxCountStats.map(c => ({
          chainId: c._id,
          recordCount: c.count,
          lastUpdate: new Date(c.lastUpdate * 1000).toISOString()
        })),
        timeRange: {
          start: new Date(oneDayAgo * 1000).toISOString(),
          end: new Date(currentTime * 1000).toISOString()
        }
      }
    });
  } catch (error) {
    logger.error('CumulativeTxCount Health Check Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router; 