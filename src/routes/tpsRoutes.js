const express = require('express');
const router = express.Router();
const tpsService = require('../services/tpsService');
const Chain = require('../models/chain');
const TPS = require('../models/tps');
const { validate, validators } = require('../utils/validationMiddleware');
const logger = require('../utils/logger');
const config = require('../config/config');

// Get TPS history for a chain
router.get('/chains/:chainId/tps/history', validate(validators.getTpsHistory), async (req, res) => {
  try {
    const { chainId } = req.params;
    const days = parseInt(req.query.days) || 30;
    const data = await tpsService.getTpsHistory(chainId, days);
    res.json({
      success: true,
      chainId,
      count: data.length,
      data
    });
  } catch (error) {
    logger.error('TPS History Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get latest TPS for a chain
router.get('/chains/:chainId/tps/latest', validate(validators.getLatestTps), async (req, res) => {
  try {
    const { chainId } = req.params;
    const data = await tpsService.getLatestTps(chainId);
    res.json({
      success: true,
      chainId,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    logger.error('Latest TPS Error:', { chainId: req.params.chainId, error: error.message });
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Add new route for total network TPS
router.get('/tps/network/latest', async (req, res) => {
  try {
    const data = await tpsService.getNetworkTps();
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Network TPS Error:', { error: error.message });
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Add new route for historical network TPS
router.get('/tps/network/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const data = await tpsService.getNetworkTpsHistory(days);
    res.json({
      success: true,
      data,
      count: data.length,
      period: `${days} days`
    });
  } catch (error) {
    logger.error('Network TPS History Error:', { days: req.query.days, error: error.message });
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Add new health check route
router.get('/tps/health', async (req, res) => {
    try {
        const chains = await Chain.find({ evmChainId: { $exists: true, $ne: null } }).select('evmChainId').lean();
        const currentTime = Math.floor(Date.now() / 1000);
        const oneDayAgo = currentTime - (24 * 60 * 60);

        const tps = await TPS.find({
            timestamp: { $gte: oneDayAgo, $lte: currentTime }
        })
            .sort({ timestamp: -1 })
            .lean();

        const chainTpsCount = await TPS.aggregate([
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
                chainIds: chains.map(c => c.evmChainId),
                recentTpsRecords: tps.length,
                lastTpsUpdate: tps[0] ? new Date(tps[0].timestamp * 1000).toISOString() : null,
                environment: config.env,
                chainsWithTps: chainTpsCount.length,
                chainTpsDetails: chainTpsCount.map(c => ({
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
        logger.error('TPS Health Check Error:', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Add new diagnostic routes
router.get('/tps/diagnostic', async (req, res) => {
    try {
        const currentTime = Math.floor(Date.now() / 1000);
        const oneDayAgo = currentTime - (24 * 60 * 60);
        
        // Get all chains
        const chains = await Chain.find({ evmChainId: { $exists: true, $ne: null } }).select('evmChainId').lean();

        // Get TPS data for each chain
        const chainData = await Promise.all(chains.map(async chain => {
            const latestTps = await TPS.findOne({
                chainId: String(chain.evmChainId),
                timestamp: { $gte: oneDayAgo, $lte: currentTime }
            })
                .sort({ timestamp: -1 })
                .lean();

            const tpsCount = await TPS.countDocuments({
                chainId: String(chain.evmChainId),
                timestamp: { $gte: oneDayAgo, $lte: currentTime }
            });

            return {
                chainId: chain.evmChainId,
                hasData: !!latestTps,
                recordCount: tpsCount,
                latestValue: latestTps?.value,
                latestTimestamp: latestTps ? new Date(latestTps.timestamp * 1000).toISOString() : null
            };
        }));

        // Get overall stats
        const totalRecords = await TPS.countDocuments({
            timestamp: { $gte: oneDayAgo, $lte: currentTime }
        });

        const chainsWithData = chainData.filter(c => c.hasData);
        const totalTps = chainsWithData.reduce((sum, chain) => sum + (chain.latestValue || 0), 0);

        res.json({
            success: true,
            environment: config.env,
            timeRange: {
                start: new Date(oneDayAgo * 1000).toISOString(),
                end: new Date(currentTime * 1000).toISOString()
            },
            summary: {
                totalChains: chains.length,
                chainsWithData: chainsWithData.length,
                totalRecords,
                calculatedTotalTps: parseFloat(totalTps.toFixed(2))
            },
            chainDetails: chainData.sort((a, b) => (b.latestValue || 0) - (a.latestValue || 0))
        });
    } catch (error) {
        logger.error('TPS Diagnostic Error:', { error: error.message });
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Add a simple status endpoint
router.get('/tps/status', async (req, res) => {
    try {
        const currentTime = Math.floor(Date.now() / 1000);
        const oneDayAgo = currentTime - (24 * 60 * 60);
        
        const tpsCount = await TPS.countDocuments({
            timestamp: { $gte: oneDayAgo, $lte: currentTime }
        });
        
        const chainCount = await Chain.countDocuments();
        
        res.json({
            success: true,
            environment: config.env,
            timestamp: new Date().toISOString(),
            stats: {
                tpsRecords: tpsCount,
                chains: chainCount,
                timeRange: {
                    start: new Date(oneDayAgo * 1000).toISOString(),
                    end: new Date(currentTime * 1000).toISOString()
                }
            }
        });
    } catch (error) {
        logger.error('TPS Status Error:', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

module.exports = router; 