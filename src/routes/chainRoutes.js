const express = require('express');
const router = express.Router();
const chainController = require('../controllers/chainController');
const { validate, validators } = require('../utils/validationMiddleware');

router.get('/chains', chainController.getAllChains);
router.get('/chains/categories', chainController.getAllCategories);
router.get('/chains/:chainId', validate(validators.getChainById), chainController.getChainById);
router.get('/chains/:chainId/validators', validate(validators.getChainValidators), chainController.getChainValidators);
router.get('/chains/:chainId/validators/direct', validate(validators.getChainValidators), chainController.fetchValidatorsDirectly);

module.exports = router;
