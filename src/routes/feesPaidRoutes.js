const express = require('express');
const router = express.Router();
const feesPaidService = require('../services/feesPaidService');
const Chain = require('../models/chain');
const FeesPaid = require('../models/feesPaid');
const logger = require('../utils/logger');

// Get fees paid history for a chain
router.get('/chains/:chainId/fees-paid/history', async (req, res) => {
  try {
    const { chainId } = req.params;
    const days = parseInt(req.query.days) || 30;
    const data = await feesPaidService.getFeesPaidHistory(chainId, days);
    res.json({
      success: true,
      chainId,
      count: data.length,
      data
    });
  } catch (error) {
    logger.error('FeesPaid History Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest fees paid for a chain
router.get('/chains/:chainId/fees-paid/latest', async (req, res) => {
  try {
    const { chainId } = req.params;
    const data = await feesPaidService.getLatestFeesPaid(chainId);
    res.json({
      success: true,
      chainId,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Latest FeesPaid Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest network-wide total fees paid
router.get('/fees-paid/network/latest', async (req, res) => {
  try {
    const data = await feesPaidService.getNetworkLatestFeesPaid();
    res.json({
      success: true,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Network FeesPaid Latest Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get network-wide fees paid history
router.get('/fees-paid/network/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const data = await feesPaidService.getNetworkFeesPaidHistory(days);
    res.json({
      success: true,
      data,
      count: data.length,
      period: `${days} days`
    });
  } catch (error) {
    logger.error('Network FeesPaid History Error:', { days: req.query.days, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
router.get('/fees-paid/health', async (req, res) => {
  try {
    const chains = await Chain.find().select('chainId evmChainId').lean();
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const feesPaidRecords = await FeesPaid.find({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    })
      .sort({ timestamp: -1 })
      .lean();

    const chainFeesPaidCount = await FeesPaid.aggregate([
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
        recentRecords: feesPaidRecords.length,
        lastUpdate: feesPaidRecords[0] ? new Date(feesPaidRecords[0].timestamp * 1000).toISOString() : null,
        chainsWithData: chainFeesPaidCount.length,
        chainDetails: chainFeesPaidCount.map(c => ({
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
    logger.error('FeesPaid Health Check Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Diagnostic endpoint
router.get('/fees-paid/diagnostic', async (req, res) => {
  try {
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const chains = await Chain.find().select('chainId evmChainId name').lean();

    const chainData = await Promise.all(chains.map(async chain => {
      const chainId = String(chain.evmChainId || chain.chainId);

      const latestRecord = await FeesPaid.findOne({
        chainId: chainId,
        timestamp: { $gte: oneDayAgo, $lte: currentTime }
      })
        .sort({ timestamp: -1 })
        .lean();

      const recordCount = await FeesPaid.countDocuments({
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

    const totalRecords = await FeesPaid.countDocuments({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    });

    const chainsWithData = chainData.filter(c => c.hasData);
    const totalFeesPaid = chainsWithData.reduce((sum, chain) => sum + (chain.latestValue || 0), 0);

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
        totalFeesPaid: parseFloat(totalFeesPaid.toFixed(2))
      },
      chainDetails: chainData.sort((a, b) => (b.latestValue || 0) - (a.latestValue || 0))
    });
  } catch (error) {
    logger.error('FeesPaid Diagnostic Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
