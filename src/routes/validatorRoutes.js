const express = require('express');
const router = express.Router();
const Chain = require('../models/chain');
const logger = require('../utils/logger');

/**
 * @route   GET /api/validators/network/stats
 * @desc    Get network-wide validator statistics
 * @access  Public
 */
router.get('/validators/network/stats', async (req, res) => {
  try {
    logger.info('Fetching network-wide validator statistics...');

    // Get all chains with validators
    const chains = await Chain.find({
      validators: { $exists: true, $ne: [] }
    }).select('chainName evmChainId subnetId validators').lean();

    // Calculate statistics
    const totalValidators = chains.reduce((sum, chain) =>
      sum + (chain.validators ? chain.validators.length : 0), 0
    );

    const chainsWithValidators = chains.length;

    const validatorCounts = chains.map(chain => ({
      chainName: chain.chainName,
      evmChainId: chain.evmChainId,
      subnetId: chain.subnetId,
      validatorCount: chain.validators ? chain.validators.length : 0
    })).sort((a, b) => b.validatorCount - a.validatorCount);

    res.json({
      success: true,
      data: {
        totalValidators,
        chainsWithValidators,
        topChainsByValidators: validatorCounts.slice(0, 10),
        allChains: validatorCounts
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Network validator stats error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @route   GET /api/validators/network/total
 * @desc    Get total validator count across network (simple endpoint)
 * @access  Public
 */
router.get('/validators/network/total', async (req, res) => {
  try {
    const chains = await Chain.find({
      validators: { $exists: true, $ne: [] }
    }).select('validators').lean();

    // Collect unique validators by nodeId
    const uniqueNodeIds = new Set();
    chains.forEach(chain => {
      if (chain.validators) {
        chain.validators.forEach(v => {
          if (v.nodeId) uniqueNodeIds.add(v.nodeId);
        });
      }
    });

    res.json({
      success: true,
      totalValidators: uniqueNodeIds.size,
      chainsWithValidators: chains.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Network validator total error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @route   GET /api/validators/distribution
 * @desc    Get validator distribution by chain
 * @access  Public
 */
router.get('/validators/distribution', async (req, res) => {
  try {
    logger.info('Fetching validator distribution...');

    const chains = await Chain.find()
      .select('chainName evmChainId validators')
      .lean();

    const distribution = chains.map(chain => ({
      chainName: chain.chainName,
      evmChainId: chain.evmChainId,
      validatorCount: chain.validators ? chain.validators.length : 0,
      hasValidators: chain.validators && chain.validators.length > 0
    })).sort((a, b) => b.validatorCount - a.validatorCount);

    const withValidators = distribution.filter(c => c.hasValidators);
    const withoutValidators = distribution.filter(c => !c.hasValidators);

    res.json({
      success: true,
      data: {
        withValidators,
        withoutValidators,
        summary: {
          totalChains: chains.length,
          chainsWithValidators: withValidators.length,
          chainsWithoutValidators: withoutValidators.length
        }
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Validator distribution error:', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
