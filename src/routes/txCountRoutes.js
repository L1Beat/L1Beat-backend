const express = require('express');
const router = express.Router();
const txCountService = require('../services/txCountService');
const Chain = require('../models/chain');
const TxCount = require('../models/txCount');
const logger = require('../utils/logger');

// Get tx count history for a chain
router.get('/chains/:chainId/tx-count/history', async (req, res) => {
  try {
    const { chainId } = req.params;
    const days = parseInt(req.query.days) || 30;
    const data = await txCountService.getTxCountHistory(chainId, days);
    res.json({
      success: true,
      chainId,
      count: data.length,
      data
    });
  } catch (error) {
    logger.error('TxCount History Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest tx count for a chain
router.get('/chains/:chainId/tx-count/latest', async (req, res) => {
  try {
    const { chainId } = req.params;
    const data = await txCountService.getLatestTxCount(chainId);
    res.json({
      success: true,
      chainId,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Latest TxCount Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest network-wide total tx count
router.get('/tx-count/network/latest', async (req, res) => {
  try {
    const data = await txCountService.getNetworkLatestTxCount();
    res.json({
      success: true,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Network TxCount Latest Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get network-wide tx count history
router.get('/tx-count/network/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const data = await txCountService.getNetworkTxCountHistory(days);
    res.json({
      success: true,
      data,
      count: data.length,
      period: `${days} days`
    });
  } catch (error) {
    logger.error('Network TxCount History Error:', { days: req.query.days, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
router.get('/tx-count/health', async (req, res) => {
  try {
    const chains = await Chain.find().select('chainId evmChainId').lean();
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const txCountRecords = await TxCount.find({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    })
      .sort({ timestamp: -1 })
      .lean();

    const chainTxCountCount = await TxCount.aggregate([
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
        recentRecords: txCountRecords.length,
        lastUpdate: txCountRecords[0] ? new Date(txCountRecords[0].timestamp * 1000).toISOString() : null,
        chainsWithData: chainTxCountCount.length,
        chainDetails: chainTxCountCount.map(c => ({
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
    logger.error('TxCount Health Check Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Diagnostic endpoint
router.get('/tx-count/diagnostic', async (req, res) => {
  try {
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const chains = await Chain.find().select('chainId evmChainId name').lean();

    const chainData = await Promise.all(chains.map(async chain => {
      const chainId = String(chain.evmChainId || chain.chainId);

      const latestRecord = await TxCount.findOne({
        chainId: chainId,
        timestamp: { $gte: oneDayAgo, $lte: currentTime }
      })
        .sort({ timestamp: -1 })
        .lean();

      const recordCount = await TxCount.countDocuments({
        chainId: chainId,
        timestamp: { $gte: oneDayAgo, $lte: currentTime }
      });

      return {
        chainId: chainId,
        name: chain.name,
        hasData: !!latestRecord,
        recordCount: recordCount,
        latestValue: latestRecord?.value,
        latestTimestamp: latestRecord ? new Date(latestRecord.timestamp * 1000).toISOString() : null
      };
    }));

    const totalRecords = await TxCount.countDocuments({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    });

    const chainsWithData = chainData.filter(c => c.hasData);
    const totalTxCount = chainsWithData.reduce((sum, chain) => sum + (chain.latestValue || 0), 0);

    res.json({
      success: true,
      timeRange: {
        start: new Date(oneDayAgo * 1000).toISOString(),
        end: new Date(currentTime * 1000).toISOString()
      },
      summary: {
        totalChains: chains.length,
        chainsWithData: chainsWithData.length,
        totalRecords,
        totalTxCount: Math.round(totalTxCount)
      },
      chainDetails: chainData.sort((a, b) => (b.latestValue || 0) - (a.latestValue || 0))
    });
  } catch (error) {
    logger.error('TxCount Diagnostic Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
