const express = require('express');
const router = express.Router();
const snowpeerController = require('../controllers/snowpeerController');

/**
 * GET /api/snowpeer/l1s
 * Fetch all L1s from SnowPeer AMDB
 * Query params:
 *   - network: mainnet | fuji (default: mainnet)
 *   - limit: number (default: 100)
 *   - page: number (default: 1)
 */
router.get('/l1s', snowpeerController.getL1s);

/**
 * GET /api/snowpeer/l1s/:id
 * Fetch a single L1 by ID from SnowPeer AMDB
 * Path params:
 *   - id: L1 subnet ID
 * Query params:
 *   - network: mainnet | fuji (default: mainnet)
 */
router.get('/l1s/:id', snowpeerController.getL1ById);

/**
 * GET /api/snowpeer/blockchains
 * Fetch blockchains from SnowPeer
 * Query params:
 *   - network: mainnet | fuji (default: mainnet)
 *   - subnetID: optional subnet ID to filter blockchains
 */
router.get('/blockchains', snowpeerController.getBlockchains);

/**
 * GET /api/snowpeer/validators/:nodeId
 * Fetch validator details from SnowPeer
 * Path params:
 *   - nodeId: Validator node ID
 * Query params:
 *   - network: mainnet | fuji (default: mainnet)
 */
router.get('/validators/:nodeId', snowpeerController.getValidator);

module.exports = router;
