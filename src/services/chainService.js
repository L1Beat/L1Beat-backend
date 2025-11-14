const Chain = require('../models/chain');
const axios = require('axios');
const config = require('../config/config');
const tpsService = require('../services/tpsService');
const cacheManager = require('../utils/cacheManager');
const logger = require('../utils/logger');

class ChainService {
    constructor() {
        this.lastUpdated = new Map(); // Track last update time for each chain
        this.updateInterval = 30 * 60 * 1000; // 30 minutes
    }

    // Get all chains with optional filtering
    async getAllChains(filters = {}) {
        try {
            const { category, network } = filters;

            // Build cache key with filters
            const cacheKey = `all_chains_${category || 'all'}_${network || 'all'}`;
            const cachedChains = cacheManager.get(cacheKey);
            if (cachedChains) {
                logger.debug('Returning cached chains data');
                return cachedChains;
            }

            // Build query
            const query = {};
            if (category) {
                query.categories = category;
            }
            if (network) {
                query.network = network;
            }

            const chains = await Chain.find(query);

            // Fetch latest TPS for each chain
            const chainsWithTps = await Promise.all(chains.map(async (chain) => {
                try {
                    // Use evmChainId if available (registry chains), otherwise use chainId (Glacier chains)
                    const chainIdForTps = chain.evmChainId || chain.chainId;

                    // Only fetch TPS if we have a numeric chain ID
                    if (!chainIdForTps || !/^\d+$/.test(String(chainIdForTps))) {
                        logger.debug(`Skipping TPS fetch for chain ${chain.chainName} - no valid numeric chain ID`);
                        return chain.toObject();
                    }

                    const tpsData = await tpsService.getLatestTps(String(chainIdForTps));
                    return {
                        ...chain.toObject(),
                        tps: tpsData ? {
                            value: parseFloat(tpsData.value).toFixed(2),
                            timestamp: tpsData.timestamp
                        } : null
                    };
                } catch (error) {
                    logger.error(`Error fetching TPS for chain ${chain.chainId}:`, { error: error.message });
                    return chain.toObject();
                }
            }));

            // Cache the result for 5 minutes
            cacheManager.set(cacheKey, chainsWithTps, config.cache.chains);

            return chainsWithTps;
        } catch (error) {
            logger.error('Error fetching chains:', { error: error.message });
            throw new Error(`Error fetching chains: ${error.message}`);
        }
    }

    // Get chain by ID
    async getChainById(chainId) {
        try {
            // Check cache first
            const cacheKey = `chain_${chainId}`;
            const cachedChain = cacheManager.get(cacheKey);
            if (cachedChain) {
                logger.debug(`Returning cached data for chain ${chainId}`);
                return cachedChain;
            }

            const chain = await Chain.findOne({ chainId });
            if (!chain) {
                throw new Error('Chain not found');
            }
            
            // Cache the result for 5 minutes
            cacheManager.set(cacheKey, chain, config.cache.chains);
            
            return chain;
        } catch (error) {
            logger.error(`Error fetching chain ${chainId}:`, { error: error.message });
            throw new Error(`Error fetching chain: ${error.message}`);
        }
    }

    // Update or create chain
    async updateChain(chainData) {
        try {
            const chainId = chainData.chainId;
            const now = Date.now();
            
            logger.info(`Chain update attempt for ${chainId}:`, {
                environment: config.env,
                timestamp: new Date().toISOString(),
                hasSubnetId: !!chainData.subnetId
            });

            // Check if chain was recently updated
            const lastUpdate = this.lastUpdated.get(chainId);
            if (lastUpdate && (now - lastUpdate) < this.updateInterval) {
                logger.info(`Skipping chain ${chainId} - updated ${Math.round((now - lastUpdate)/1000)}s ago`);
                return null;
            }

            const validators = await this.fetchValidators(chainData.subnetId, chainId);
            
            logger.info(`Chain ${chainId} update details:`, {
                validatorCount: validators.length,
                environment: config.env,
                subnetId: chainData.subnetId,
                timestamp: new Date().toISOString()
            });

            const updatedChain = await Chain.findOneAndUpdate(
                { chainId },
                { 
                    ...chainData,
                    validators,
                    lastUpdated: new Date()
                },
                { upsert: true, new: true }
            );
            
            // Update last update time
            this.lastUpdated.set(chainId, now);
            
            // Invalidate cache for this chain
            cacheManager.delete(`chain_${chainId}`);
            cacheManager.delete('all_chains');
            
            logger.info(`Chain ${chainId} updated with ${updatedChain.validators.length} validators`);
            return updatedChain;
            
        } catch (error) {
            logger.error(`Error updating chain ${chainData.chainId}:`, { error: error.message, stack: error.stack });
            throw error;
        }
    }

    async fetchValidators(subnetId, chainId) {
        try {
            if (!subnetId) {
                // If no subnetId, try to fetch validators using the alternative method
                return await this.fetchAlternativeValidators(chainId);
            }
            
            let allValidators = [];
            let nextPageToken = null;
            
            // Try first Glacier API endpoint (validators)
            do {
                const validatorsEndpoint = config.api.glacier.endpoints.validators;
                const url = new URL(`${config.api.glacier.baseUrl}${validatorsEndpoint}`);
                url.searchParams.append('subnetId', subnetId);
                url.searchParams.append('pageSize', '100');
                url.searchParams.append('validationStatus', 'active');
                
                if (nextPageToken) {
                    url.searchParams.append('pageToken', nextPageToken);
                }

                logger.debug(`Fetching validators from primary endpoint: ${url.toString()}`);
                const response = await fetch(url.toString(), {
                    headers: {
                        'Accept': 'application/json',
                        'x-glacier-api-key': config.api.glacier.apiKey
                    }
                });
                if (!response.ok) {
                    logger.warn(`Primary Glacier API request failed for subnet ${subnetId}, trying L1Validators endpoint`);
                    break; // Exit loop and try secondary endpoint
                }

                const data = await response.json();
                allValidators = [...allValidators, ...data.validators];
                nextPageToken = data.nextPageToken;
                
                logger.debug(`Fetched ${data.validators.length} validators from primary endpoint. Next page token: ${nextPageToken}`);
            } while (nextPageToken);

            // If no validators found from primary endpoint, try L1Validators endpoint
            if (allValidators.length === 0) {
                logger.info(`No validators found from primary endpoint for subnet ${subnetId}, trying L1Validators endpoint`);
                
                // Try L1Validators endpoint with subnetId parameter
                try {
                    const l1ValidatorsEndpoint = config.api.glacier.endpoints.l1Validators;
                    const secondaryUrl = new URL(`${config.api.glacier.baseUrl}${l1ValidatorsEndpoint}`);
                    secondaryUrl.searchParams.append('subnetId', subnetId);
                    secondaryUrl.searchParams.append('pageSize', '100');
                    
                    logger.debug(`Fetching validators from L1Validators endpoint: ${secondaryUrl.toString()}`);
                    const response = await fetch(secondaryUrl.toString(), {
                        headers: {
                            'Accept': 'application/json',
                            'x-glacier-api-key': config.api.glacier.apiKey
                        }
                    });
                    if (!response.ok) {
                        throw new Error(`L1Validators API request failed with status ${response.status}`);
                    }
                    
                    const data = await response.json();
                    
                    // L1Validators response format is different, so we need to transform it
                    const transformedValidators = (data.validators || []).map(v => ({
                        nodeId: v.nodeId || '',
                        txHash: v.validationId || v.validationIdHex || '',
                        amountStaked: v.weight ? v.weight.toString() : '0',
                        startTimestamp: v.creationTimestamp || 0,
                        endTimestamp: 0, // End timestamp might not be available
                        validationStatus: 'active',
                        uptimePerformance: 100, // Default value
                        avalancheGoVersion: '' // Not available in this endpoint
                    }));
                    
                    allValidators = transformedValidators;
                    
                    logger.info(`Fetched ${allValidators.length} validators from L1Validators endpoint`);
                    
                    // If there's a nextPageToken, we should handle pagination for L1Validators too
                    let l1NextPageToken = data.nextPageToken;
                    
                    while (l1NextPageToken) {
                        const nextPageUrl = new URL(`${config.api.glacier.baseUrl}${l1ValidatorsEndpoint}`);
                        nextPageUrl.searchParams.append('subnetId', subnetId);
                        nextPageUrl.searchParams.append('pageSize', '100');
                        nextPageUrl.searchParams.append('pageToken', l1NextPageToken);
                        
                        const nextPageResponse = await fetch(nextPageUrl.toString(), {
                            headers: {
                                'Accept': 'application/json',
                                'x-glacier-api-key': config.api.glacier.apiKey
                            }
                        });
                        if (!nextPageResponse.ok) {
                            logger.warn(`Failed to fetch next page of L1Validators, status: ${nextPageResponse.status}`);
                            break;
                        }
                        
                        const nextPageData = await nextPageResponse.json();
                        
                        const nextPageValidators = (nextPageData.validators || []).map(v => ({
                            nodeId: v.nodeId || '',
                            txHash: v.validationId || v.validationIdHex || '',
                            amountStaked: v.weight ? v.weight.toString() : '0',
                            startTimestamp: v.creationTimestamp || 0,
                            endTimestamp: 0,
                            validationStatus: 'active',
                            uptimePerformance: 100,
                            avalancheGoVersion: ''
                        }));
                        
                        allValidators = [...allValidators, ...nextPageValidators];
                        l1NextPageToken = nextPageData.nextPageToken;
                        
                        logger.debug(`Fetched ${nextPageValidators.length} additional validators from L1Validators endpoint. Next page token: ${l1NextPageToken}`);
                    }
                } catch (secondaryError) {
                    logger.error(`Error fetching validators from L1Validators endpoint for subnet ${subnetId}:`, 
                        { error: secondaryError.message });
                    
                    // If L1Validators endpoint also fails, try alternative validator source
                    return await this.fetchAlternativeValidators(chainId);
                }
            }

            logger.info(`Total validators fetched for chain ${chainId}: ${allValidators.length}`);
            return allValidators;
            
        } catch (error) {
            logger.error(`Error fetching validators for subnet ${subnetId}:`, { error: error.message });
            // If any error occurs, try the alternative method
            return await this.fetchAlternativeValidators(chainId);
        }
    }

    async fetchAlternativeValidators(chainId) {
        if (!chainId) return [];
        
        try {
            // Get the alternative validator endpoints from configuration
            const alternativeValidatorEndpoints = config.api.alternativeValidators || {};

            // Check if we have an alternative endpoint for this chain
            if (!alternativeValidatorEndpoints[chainId]) {
                logger.info(`No alternative validator endpoint configured for chain ${chainId}`);
                return [];
            }

            logger.info(`Fetching validators from alternative endpoint for chain ${chainId}`);
            const response = await fetch(alternativeValidatorEndpoints[chainId], {
                timeout: config.api.glacier.timeout, // Use the same timeout as Glacier API
                headers: {
                    'Accept': 'application/json',
                    'x-glacier-api-key': config.api.glacier.apiKey
                }
            });
            
            if (!response.ok) {
                throw new Error(`Alternative API request failed with status ${response.status}`);
            }

            const data = await response.json();
            
            // Process response according to the expected format
            // This may need to be customized based on the response format of each alternative API
            const validators = Array.isArray(data.validators) ? data.validators : 
                              Array.isArray(data) ? data : [];
            
            logger.info(`Total validators fetched from alternative endpoint: ${validators.length}`);
            
            // Transform the data to match the expected format if necessary
            return validators.map(v => ({
                nodeId: v.nodeId || v.id || '',
                txHash: v.txHash || '',
                amountStaked: v.amountStaked || v.stake || '0',
                startTimestamp: v.startTimestamp || v.start || 0,
                endTimestamp: v.endTimestamp || v.end || 0,
                validationStatus: v.validationStatus || 'active',
                uptimePerformance: v.uptimePerformance || 100,
                avalancheGoVersion: v.avalancheGoVersion || ''
            }));
            
        } catch (error) {
            logger.error(`Error fetching alternative validators for chain ${chainId}:`, { error: error.message });
            return [];
        }
    }

    // Clear update tracking (useful for testing or manual resets)
    clearUpdateTracking() {
        this.lastUpdated.clear();
        logger.info('Cleared all chain update tracking');
    }

    // Update only the validators for a specific chain
    async updateValidatorsOnly(chainId, validators) {
        try {
            if (!chainId) {
                throw new Error('Chain ID is required');
            }

            logger.info(`Updating validators only for chain ${chainId}`);

            const updatedChain = await Chain.findOneAndUpdate(
                { chainId },
                {
                    validators,
                    lastUpdated: new Date()
                },
                { new: true }
            );

            if (!updatedChain) {
                throw new Error('Chain not found');
            }

            // Invalidate cache for this chain
            cacheManager.delete(`chain_${chainId}`);
            cacheManager.delete('all_chains');

            logger.info(`Updated ${updatedChain.validators.length} validators for chain ${chainId}`);
            return updatedChain;
        } catch (error) {
            logger.error(`Error updating validators for chain ${chainId}:`, { error: error.message });
            throw error;
        }
    }

    // Get all unique categories
    async getAllCategories() {
        try {
            const cacheKey = 'all_categories';
            const cachedCategories = cacheManager.get(cacheKey);
            if (cachedCategories) {
                logger.debug('Returning cached categories');
                return cachedCategories;
            }

            const categories = await Chain.distinct('categories');
            const sortedCategories = categories.filter(cat => cat).sort();

            cacheManager.set(cacheKey, sortedCategories, config.cache.chains);
            return sortedCategories;
        } catch (error) {
            logger.error('Error fetching categories:', { error: error.message });
            throw new Error(`Error fetching categories: ${error.message}`);
        }
    }

    // Enrich chain with live Glacier data (validators, metrics)
    async enrichChainWithGlacierData(chainData) {
        try {
            logger.debug(`Enriching chain ${chainData.chainName} with Glacier data`);

            // Fetch validators if subnetId is available
            let validators = [];
            if (chainData.subnetId) {
                validators = await this.fetchValidators(chainData.subnetId, chainData.chainId);
            }

            // Update chain with live data
            const enrichedChain = {
                ...chainData,
                validators: validators,
                lastUpdated: new Date()
            };

            return enrichedChain;
        } catch (error) {
            logger.error(`Error enriching chain with Glacier data:`, { error: error.message });
            return chainData;
        }
    }
}

module.exports = new ChainService();
