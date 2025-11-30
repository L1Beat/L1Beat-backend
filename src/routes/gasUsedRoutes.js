const express = require('express');
const router = express.Router();
const gasUsedService = require('../services/gasUsedService');
const Chain = require('../models/chain');
const GasUsed = require('../models/gasUsed');
const logger = require('../utils/logger');

// Get gas used history for a chain
router.get('/chains/:chainId/gas-used/history', async (req, res) => {
  try {
    const { chainId } = req.params;
    const days = parseInt(req.query.days) || 30;
    const data = await gasUsedService.getGasUsedHistory(chainId, days);
    res.json({
      success: true,
      chainId,
      count: data.length,
      data
    });
  } catch (error) {
    logger.error('GasUsed History Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest gas used for a chain
router.get('/chains/:chainId/gas-used/latest', async (req, res) => {
  try {
    const { chainId } = req.params;
    const data = await gasUsedService.getLatestGasUsed(chainId);
    res.json({
      success: true,
      chainId,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Latest GasUsed Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest network-wide total gas used
router.get('/gas-used/network/latest', async (req, res) => {
  try {
    const data = await gasUsedService.getNetworkLatestGasUsed();
    res.json({
      success: true,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Network GasUsed Latest Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get network-wide gas used history
router.get('/gas-used/network/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const data = await gasUsedService.getNetworkGasUsedHistory(days);
    res.json({
      success: true,
      data,
      count: data.length,
      period: `${days} days`
    });
  } catch (error) {
    logger.error('Network GasUsed History Error:', { days: req.query.days, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
router.get('/gas-used/health', async (req, res) => {
  try {
    const chains = await Chain.find().select('chainId evmChainId').lean();
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const gasUsedRecords = await GasUsed.find({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    })
      .sort({ timestamp: -1 })
      .lean();

    const chainGasUsedCount = await GasUsed.aggregate([
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
        recentRecords: gasUsedRecords.length,
        lastUpdate: gasUsedRecords[0] ? new Date(gasUsedRecords[0].timestamp * 1000).toISOString() : null,
        chainsWithData: chainGasUsedCount.length,
        chainDetails: chainGasUsedCount.map(c => ({
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
    logger.error('GasUsed Health Check Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Diagnostic endpoint
router.get('/gas-used/diagnostic', async (req, res) => {
  try {
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const chains = await Chain.find().select('chainId evmChainId name').lean();

    const chainData = await Promise.all(chains.map(async chain => {
      const chainId = String(chain.evmChainId || chain.chainId);

      const latestRecord = await GasUsed.findOne({
        chainId: chainId,
        timestamp: { $gte: oneDayAgo, $lte: currentTime }
      })
        .sort({ timestamp: -1 })
        .lean();

      const recordCount = await GasUsed.countDocuments({
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

    const totalRecords = await GasUsed.countDocuments({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    });

    const chainsWithData = chainData.filter(c => c.hasData);
    const totalGasUsed = chainsWithData.reduce((sum, chain) => sum + (chain.latestValue || 0), 0);

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
        totalGasUsed: parseFloat(totalGasUsed.toFixed(2))
      },
      chainDetails: chainData.sort((a, b) => (b.latestValue || 0) - (a.latestValue || 0))
    });
  } catch (error) {
    logger.error('GasUsed Diagnostic Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
