const axios = require('axios');
const config = require('../config/config');
const logger = require('../utils/logger');

class ChainDataService {
    constructor() {
        this.GLACIER_API_BASE = config.api.glacier.baseUrl;
        this.GLACIER_API_KEY = process.env.GLACIER_API_KEY;
        
        // Log API key status (without revealing the actual key)
        logger.info('ChainDataService - Glacier API Key status:', {
            hasApiKey: !!this.GLACIER_API_KEY,
            apiKeyLength: this.GLACIER_API_KEY ? this.GLACIER_API_KEY.length : 0
        });
    }

    async fetchChainData() {
        try {
            logger.info('Fetching chains from Glacier API...');
            
            // Prepare headers with API key
            const headers = {
                'Accept': 'application/json',
                'User-Agent': 'l1beat-backend'
            };
            
            // Add API key header if available - first check env var, then config
            if (this.GLACIER_API_KEY) {
                headers['x-glacier-api-key'] = this.GLACIER_API_KEY;
                logger.debug('Using Glacier API key from environment variables');
            } else if (config.api.glacier.apiKey) {
                headers['x-glacier-api-key'] = config.api.glacier.apiKey;
                logger.debug('Using Glacier API key from config');
            }
            
            // Log request details (without exposing full API key)
            logger.info('Making Glacier chains API request:', {
                endpoint: '/chains',
                hasApiKey: !!headers['x-glacier-api-key'],
                apiKeyPrefix: headers['x-glacier-api-key'] ? `${headers['x-glacier-api-key'].substring(0, 4)}...` : 'none'
            });
            
            const response = await axios.get(`${this.GLACIER_API_BASE}/chains`, {
                timeout: config.api.glacier.timeout,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'l1beat-backend',
                    'x-glacier-api-key': this.GLACIER_API_KEY
                }
            });
            
            logger.info('Glacier API Response:', {
                status: response.status,
                chainCount: response.data?.chains?.length || 0
            });

            if (!response.data || !response.data.chains) {
                throw new Error('Invalid response from Glacier API');
            }
            
            const chains = response.data.chains.filter(chain => !chain.isTestnet);
            logger.info(`Filtered ${chains.length} non-testnet chains`);
            
            return chains;
            
        } catch (error) {
            logger.error('Error fetching chain data:', {
                message: error.message,
                status: error.response?.status,
                data: error.response?.data
            });
            throw error;
        }
    }
}

module.exports = new ChainDataService(); 