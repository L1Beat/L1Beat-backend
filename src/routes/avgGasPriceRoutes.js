const express = require('express');
const router = express.Router();
const avgGasPriceService = require('../services/avgGasPriceService');
const Chain = require('../models/chain');
const AvgGasPrice = require('../models/avgGasPrice');
const logger = require('../utils/logger');

// Get average gas price history for a chain
router.get('/chains/:chainId/avg-gas-price/history', async (req, res) => {
  try {
    const { chainId } = req.params;
    const days = parseInt(req.query.days) || 30;
    const data = await avgGasPriceService.getAvgGasPriceHistory(chainId, days);
    res.json({
      success: true,
      chainId,
      count: data.length,
      data
    });
  } catch (error) {
    logger.error('AvgGasPrice History Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest average gas price for a chain
router.get('/chains/:chainId/avg-gas-price/latest', async (req, res) => {
  try {
    const { chainId } = req.params;
    const data = await avgGasPriceService.getLatestAvgGasPrice(chainId);
    res.json({
      success: true,
      chainId,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Latest AvgGasPrice Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest network-wide average gas price
router.get('/avg-gas-price/network/latest', async (req, res) => {
  try {
    const data = await avgGasPriceService.getNetworkLatestAvgGasPrice();
    res.json({
      success: true,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Network AvgGasPrice Latest Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get network-wide average gas price history
router.get('/avg-gas-price/network/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const data = await avgGasPriceService.getNetworkAvgGasPriceHistory(days);
    res.json({
      success: true,
      data,
      count: data.length,
      period: `${days} days`
    });
  } catch (error) {
    logger.error('Network AvgGasPrice History Error:', { days: req.query.days, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
router.get('/avg-gas-price/health', async (req, res) => {
  try {
    const chains = await Chain.find().select('chainId evmChainId').lean();
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const avgGasPriceRecords = await AvgGasPrice.find({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    })
      .sort({ timestamp: -1 })
      .lean();

    const chainAvgGasPriceCount = await AvgGasPrice.aggregate([
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
        recentRecords: avgGasPriceRecords.length,
        lastUpdate: avgGasPriceRecords[0] ? new Date(avgGasPriceRecords[0].timestamp * 1000).toISOString() : null,
        chainsWithData: chainAvgGasPriceCount.length,
        chainDetails: chainAvgGasPriceCount.map(c => ({
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
    logger.error('AvgGasPrice Health Check Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Diagnostic endpoint
router.get('/avg-gas-price/diagnostic', async (req, res) => {
  try {
    const currentTime = Math.floor(Date.now() / 1000);
    const oneDayAgo = currentTime - (24 * 60 * 60);

    const chains = await Chain.find().select('chainId evmChainId name').lean();

    const chainData = await Promise.all(chains.map(async chain => {
      const chainId = String(chain.evmChainId || chain.chainId);

      const latestRecord = await AvgGasPrice.findOne({
        chainId: chainId,
        timestamp: { $gte: oneDayAgo, $lte: currentTime }
      })
        .sort({ timestamp: -1 })
        .lean();

      const recordCount = await AvgGasPrice.countDocuments({
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

    const totalRecords = await AvgGasPrice.countDocuments({
      timestamp: { $gte: oneDayAgo, $lte: currentTime }
    });

    const chainsWithData = chainData.filter(c => c.hasData);
    const totalAvgGasPrice = chainsWithData.reduce((sum, chain) => sum + (chain.latestValue || 0), 0);
    const networkAvgGasPrice = chainsWithData.length > 0 ? totalAvgGasPrice / chainsWithData.length : 0;

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
        networkAvgGasPrice: parseFloat(networkAvgGasPrice.toFixed(9))
      },
      chainDetails: chainData.sort((a, b) => (b.latestValue || 0) - (a.latestValue || 0))
    });
  } catch (error) {
    logger.error('AvgGasPrice Diagnostic Error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
