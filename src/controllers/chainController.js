const chainService = require('../services/chainService');

exports.getAllChains = async (req, res) => {
    try {
        const { category, network } = req.query;
        console.log('Fetching all chains with filters:', { category, network });

        const filters = {};
        if (category) filters.category = category;
        if (network) filters.network = network;

        const chains = await chainService.getAllChains(filters);

        // Note: X-Chain and P-Chain are already excluded from l1-registry
        // No need to filter here (previous filter accidentally excluded C-Chain due to substring match bug)

        console.log('Chains fetched:', {
            count: chains?.length || 0,
            firstChain: chains?.[0] ? chains[0].chainId : null,
            filters
        });

        res.json(chains || []);
    } catch (error) {
        console.error('Error in getAllChains:', error);
        res.status(500).json({
            error: 'Failed to fetch chains',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

exports.getChainById = async (req, res) => {
    try {
        const chain = await chainService.getChainById(req.params.chainId);
        res.json(chain);
    } catch (error) {
        if (error.message === 'Chain not found') {
            res.status(404).json({ error: error.message });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
};

exports.getChainValidators = async (req, res) => {
    try {
        const chain = await chainService.getChainById(req.params.chainId);
        res.json(chain.validators || []);
    } catch (error) {
        if (error.message === 'Chain not found') {
            res.status(404).json({ error: error.message });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
};

// Fetch validators directly from source for a specific chain
exports.fetchValidatorsDirectly = async (req, res) => {
    try {
        const { chainId } = req.params;
        const { force } = req.query;

        // Get the chain to check if it has a subnetId
        const chain = await chainService.getChainById(chainId);

        // Force refresh from source if requested, otherwise use what's stored
        if (force !== 'true' && chain.validators && chain.validators.length > 0) {
            return res.json(chain.validators);
        }

        // Fetch validators directly from the appropriate source
        const validators = await chainService.fetchValidators(chain.subnetId, chainId);

        // Update the chain with the latest validators if any were found
        if (validators && validators.length > 0) {
            await chainService.updateValidatorsOnly(chainId, validators);
        }

        res.json(validators || []);
    } catch (error) {
        if (error.message === 'Chain not found') {
            res.status(404).json({ error: error.message });
        } else {
            res.status(500).json({
                error: 'Failed to fetch validators',
                message: error.message
            });
        }
    }
};

// Get all unique categories
exports.getAllCategories = async (req, res) => {
    try {
        console.log('Fetching all categories...');
        const categories = await chainService.getAllCategories();

        console.log('Categories fetched:', {
            count: categories?.length || 0,
            categories
        });

        res.json(categories || []);
    } catch (error) {
        console.error('Error in getAllCategories:', error);
        res.status(500).json({
            error: 'Failed to fetch categories',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};
