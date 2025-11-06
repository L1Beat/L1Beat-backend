const axios = require('axios');
const config = require('../config/config');
const logger = require('../utils/logger');
const cacheManager = require('../utils/cacheManager');

const SNOWPEER_BASE_URL = 'https://api.snowpeer.io/v1';
const DEFAULT_NETWORK = 'mainnet';

/**
 * Helper function to retry requests with exponential backoff
 */
async function retryRequest(requestFn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      const isRateLimited = error.response?.status === 429 ||
                           error.message?.includes('Too many requests');

      if (isRateLimited && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warn(`Rate limited, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }
}

/**
 * Fetch all L1s from SnowPeer AMDB
 */
async function getL1s(req, res) {
  try {
    const { network = DEFAULT_NETWORK, limit = 100, page = 1 } = req.query;
    const cacheKey = `snowpeer-l1s-${network}-${limit}-${page}`;

    // Check cache first
    const cached = cacheManager.get(cacheKey);
    if (cached) {
      logger.debug('Returning cached SnowPeer L1s data', { network, limit, page });
      return res.json(cached);
    }

    // Fetch from SnowPeer API with retry logic
    logger.info('Fetching L1s from SnowPeer AMDB', { network, limit, page });

    const response = await retryRequest(async () => {
      return await axios.get(`${SNOWPEER_BASE_URL}/amdb/l1s`, {
        params: { network, limit, page },
        timeout: config.api?.snowpeer?.timeout || 30000,
      });
    });

    const apiResponse = response.data;

    // Normalize response format: SnowPeer returns {l1s: [], metadata: {}}
    // We normalize to {data: [], metadata: {}} for consistency
    const normalizedData = {
      data: apiResponse.l1s || [],
      metadata: apiResponse.metadata || {}
    };

    // Cache the normalized result
    cacheManager.set(cacheKey, normalizedData, config.cache?.snowpeer || 300000); // 5 min default

    logger.info('Successfully fetched SnowPeer L1s', {
      count: normalizedData.data.length,
      totalCount: normalizedData.metadata.totalCount || 0
    });

    res.json(normalizedData);
  } catch (error) {
    logger.error('Error fetching SnowPeer L1s:', {
      message: error.message,
      stack: error.stack,
      url: error.config?.url,
      status: error.response?.status
    });

    // Return error response
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch L1s from SnowPeer',
      message: error.message,
      details: error.response?.data || null
    });
  }
}

/**
 * Fetch a single L1 by ID from SnowPeer AMDB
 */
async function getL1ById(req, res) {
  try {
    const { id } = req.params;
    const { network = DEFAULT_NETWORK } = req.query;
    const cacheKey = `snowpeer-l1-${id}-${network}`;

    // Check cache first
    const cached = cacheManager.get(cacheKey);
    if (cached) {
      logger.debug('Returning cached SnowPeer L1 data', { id, network });
      return res.json(cached);
    }

    // Fetch from SnowPeer API with retry logic
    logger.info('Fetching L1 from SnowPeer AMDB', { id, network });

    const response = await retryRequest(async () => {
      return await axios.get(`${SNOWPEER_BASE_URL}/amdb/l1s/${id}`, {
        params: { network },
        timeout: config.api?.snowpeer?.timeout || 30000,
      });
    });

    const apiResponse = response.data;

    // Normalize response format: SnowPeer returns the L1 object directly
    // We wrap it in {data: {}} for consistency
    const normalizedData = {
      data: apiResponse
    };

    // Cache the normalized result
    cacheManager.set(cacheKey, normalizedData, config.cache?.snowpeer || 300000); // 5 min default

    logger.info('Successfully fetched SnowPeer L1', { id, name: apiResponse.name || 'unknown' });

    res.json(normalizedData);
  } catch (error) {
    logger.error('Error fetching SnowPeer L1:', {
      id: req.params.id,
      message: error.message,
      stack: error.stack,
      url: error.config?.url,
      status: error.response?.status
    });

    // Return 404 if not found, otherwise 500
    const statusCode = error.response?.status === 404 ? 404 : (error.response?.status || 500);

    res.status(statusCode).json({
      error: 'Failed to fetch L1 from SnowPeer',
      message: error.message,
      details: error.response?.data || null
    });
  }
}

/**
 * Fetch blockchains from SnowPeer
 */
async function getBlockchains(req, res) {
  try {
    const { network = DEFAULT_NETWORK, subnetID } = req.query;
    const cacheKey = `snowpeer-blockchains-${network}-${subnetID || 'all'}`;

    // Check cache first
    const cached = cacheManager.get(cacheKey);
    if (cached) {
      logger.debug('Returning cached SnowPeer blockchains data', { network, subnetID });
      return res.json(cached);
    }

    // Fetch from SnowPeer API with retry logic
    logger.info('Fetching blockchains from SnowPeer', { network, subnetID });

    const params = { network };
    if (subnetID) {
      params.subnetID = subnetID;
    }

    const response = await retryRequest(async () => {
      return await axios.get(`${SNOWPEER_BASE_URL}/blockchains`, {
        params,
        timeout: config.api?.snowpeer?.timeout || 30000,
      });
    });

    const apiResponse = response.data;

    // Normalize response format: SnowPeer returns {blockchains: [], metadata: []}
    // We normalize to {data: [], metadata: {}} for consistency
    const normalizedData = {
      data: apiResponse.blockchains || [],
      metadata: Array.isArray(apiResponse.metadata) && apiResponse.metadata.length > 0
        ? apiResponse.metadata[0]
        : {}
    };

    // Cache the normalized result
    cacheManager.set(cacheKey, normalizedData, config.cache?.snowpeer || 300000); // 5 min default

    logger.info('Successfully fetched SnowPeer blockchains', {
      count: normalizedData.data.length
    });

    res.json(normalizedData);
  } catch (error) {
    logger.error('Error fetching SnowPeer blockchains:', {
      message: error.message,
      stack: error.stack,
      url: error.config?.url,
      status: error.response?.status
    });

    // Return error response
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch blockchains from SnowPeer',
      message: error.message,
      details: error.response?.data || null
    });
  }
}

/**
 * Fetch validator details from SnowPeer
 */
async function getValidator(req, res) {
  try {
    const { nodeId } = req.params;
    const { network = DEFAULT_NETWORK } = req.query;
    const cacheKey = `snowpeer-validator-${nodeId}-${network}`;

    // Check cache first
    const cached = cacheManager.get(cacheKey);
    if (cached) {
      logger.debug('Returning cached SnowPeer validator data', { nodeId, network });
      return res.json(cached);
    }

    // Fetch from SnowPeer API with retry logic
    logger.info('Fetching validator from SnowPeer', { nodeId, network });

    const response = await retryRequest(async () => {
      return await axios.get(`${SNOWPEER_BASE_URL}/validators/${nodeId}`, {
        params: { network },
        timeout: config.api?.snowpeer?.timeout || 30000,
      });
    });

    const data = response.data;

    // Cache the result
    cacheManager.set(cacheKey, data, config.cache?.snowpeer || 300000); // 5 min default

    logger.info('Successfully fetched SnowPeer validator', { nodeId });

    res.json(data);
  } catch (error) {
    logger.error('Error fetching SnowPeer validator:', {
      nodeId: req.params.nodeId,
      message: error.message,
      stack: error.stack,
      url: error.config?.url,
      status: error.response?.status
    });

    // Return error response
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch validator from SnowPeer',
      message: error.message,
      details: error.response?.data || null
    });
  }
}

/**
 * Fetch all subnets from SnowPeer
 */
async function getSubnets(req, res) {
  try {
    const { limit = 100, page = 1 } = req.query;
    const cacheKey = `snowpeer-subnets-${limit}-${page}`;

    // Check cache first
    const cached = cacheManager.get(cacheKey);
    if (cached) {
      logger.debug('Returning cached SnowPeer subnets data', { limit, page });
      return res.json(cached);
    }

    // Fetch from SnowPeer API with retry logic
    logger.info('Fetching subnets from SnowPeer', { limit, page });

    const response = await retryRequest(async () => {
      return await axios.get(`${SNOWPEER_BASE_URL}/subnets`, {
        params: { limit, page },
        timeout: config.api?.snowpeer?.timeout || 30000,
      });
    });

    const apiResponse = response.data;

    // Normalize response format
    const normalizedData = {
      data: apiResponse.subnets || [],
      metadata: apiResponse.metadata || []
    };

    // Cache the normalized result
    cacheManager.set(cacheKey, normalizedData, config.cache?.snowpeer || 300000); // 5 min default

    logger.info('Successfully fetched SnowPeer subnets', {
      count: normalizedData.data.length
    });

    res.json(normalizedData);
  } catch (error) {
    logger.error('Error fetching SnowPeer subnets:', {
      message: error.message,
      stack: error.stack,
      url: error.config?.url,
      status: error.response?.status
    });

    // Return error response
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch subnets from SnowPeer',
      message: error.message,
      details: error.response?.data || null
    });
  }
}

/**
 * Fetch a single subnet by ID from SnowPeer
 */
async function getSubnetById(req, res) {
  try {
    const { id } = req.params;
    const cacheKey = `snowpeer-subnet-${id}`;

    // Check cache first
    const cached = cacheManager.get(cacheKey);
    if (cached) {
      logger.debug('Returning cached SnowPeer subnet data', { id });
      return res.json(cached);
    }

    // Fetch from SnowPeer API with retry logic
    logger.info('Fetching subnet from SnowPeer', { id });

    const response = await retryRequest(async () => {
      return await axios.get(`${SNOWPEER_BASE_URL}/subnets/${id}`, {
        timeout: config.api?.snowpeer?.timeout || 30000,
      });
    });

    const apiResponse = response.data;

    // Normalize response format
    const normalizedData = {
      data: apiResponse
    };

    // Cache the normalized result
    cacheManager.set(cacheKey, normalizedData, config.cache?.snowpeer || 300000); // 5 min default

    logger.info('Successfully fetched SnowPeer subnet', { id, name: apiResponse.name || 'unknown' });

    res.json(normalizedData);
  } catch (error) {
    logger.error('Error fetching SnowPeer subnet:', {
      id: req.params.id,
      message: error.message,
      stack: error.stack,
      url: error.config?.url,
      status: error.response?.status
    });

    // Return 404 if not found, otherwise 500
    const statusCode = error.response?.status === 404 ? 404 : (error.response?.status || 500);

    res.status(statusCode).json({
      error: 'Failed to fetch subnet from SnowPeer',
      message: error.message,
      details: error.response?.data || null
    });
  }
}

module.exports = {
  getL1s,
  getL1ById,
  getBlockchains,
  getValidator,
  getSubnets,
  getSubnetById
};
