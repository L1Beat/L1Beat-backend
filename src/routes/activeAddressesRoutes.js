const express = require('express');
const router = express.Router();
const activeAddressesService = require('../services/activeAddressesService');
const Chain = require('../models/chain');
const ActiveAddresses = require('../models/activeAddresses');
const logger = require('../utils/logger');

// Get active addresses history for a chain
router.get('/chains/:chainId/active-addresses/history', async (req, res) => {
  try {
    const { chainId } = req.params;
    const days = parseInt(req.query.days) || 30;
    const data = await activeAddressesService.getActiveAddressesHistory(chainId, days);
    res.json({
      success: true,
      chainId,
      count: data.length,
      data
    });
  } catch (error) {
    logger.error('Active Addresses History Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest active addresses for a chain
router.get('/chains/:chainId/active-addresses/latest', async (req, res) => {
  try {
    const { chainId } = req.params;
    const data = await activeAddressesService.getLatestActiveAddresses(chainId);
    res.json({
      success: true,
      chainId,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Latest Active Addresses Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest network-wide total active addresses
router.get('/active-addresses/network/latest', async (req, res) => {
  try {
    const data = await activeAddressesService.getNetworkLatestActiveAddresses();
    res.json({
      success: true,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Network Active Addresses Latest Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get network-wide active addresses history
router.get('/active-addresses/network/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const data = await activeAddressesService.getNetworkActiveAddressesHistory(days);
    res.json({
      success: true,
      data,
      count: data.length,
      period: `${days} days`
    });
  } catch (error) {
    logger.error('Network Active Addresses History Error:', { days: req.query.days, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
router.get('/active-addresses/health', async (req, res) => {
  try {
    const chains = await Chain.find().select('chainId evmChainId').lean();
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const activeAddressesRecords = await ActiveAddresses.find({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    })
      .sort({ timestamp: -1 })
      .lean();

    const chainActiveAddressesCount = await ActiveAddresses.aggregate([
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
        recentRecords: activeAddressesRecords.length,
        lastUpdate: activeAddressesRecords[0] ? new Date(activeAddressesRecords[0].timestamp * 1000).toISOString() : null,
        chainsWithData: chainActiveAddressesCount.length,
        chainDetails: chainActiveAddressesCount.map(c => ({
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
    logger.error('Active Addresses Health Check Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Diagnostic endpoint
router.get('/active-addresses/diagnostic', async (req, res) => {
  try {
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const chains = await Chain.find().select('chainId evmChainId name').lean();

    const chainData = await Promise.all(chains.map(async chain => {
      const chainId = String(chain.evmChainId || chain.chainId);

      const latestRecord = await ActiveAddresses.findOne({
        chainId: chainId,
        timestamp: { $gte: oneDayAgo, $lte: currentTime }
      })
        .sort({ timestamp: -1 })
        .lean();

      const recordCount = await ActiveAddresses.countDocuments({
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

    const totalRecords = await ActiveAddresses.countDocuments({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    });

    const chainsWithData = chainData.filter(c => c.hasData);
    const totalActiveAddresses = chainsWithData.reduce((sum, chain) => sum + (chain.latestValue || 0), 0);

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
        totalActiveAddresses: Math.round(totalActiveAddresses)
      },
      chainDetails: chainData.sort((a, b) => (b.latestValue || 0) - (a.latestValue || 0))
    });
  } catch (error) {
    logger.error('Active Addresses Diagnostic Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
