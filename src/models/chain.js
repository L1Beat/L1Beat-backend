const mongoose = require('mongoose');

const chainSchema = new mongoose.Schema({
    subnetId: { type: String, required: true, unique: true },
    blockchainId: { type: String, unique: true, sparse: true },
    status: String,
    chainName: String,
    description: String,
    platformChainId: String,
    vmId: String,
    vmName: String,
    explorerUrl: String,
    rpcUrl: String,
    wsUrl: String,
    isTestnet: Boolean,
    utilityAddresses: {
        multicall: String
    },
    networkToken: {
        name: String,
        symbol: String,
        decimals: Number,
        logoUri: String,
        description: String
    },
    chainLogoUri: String,
    private: Boolean,
    enabledFeatures: [String],
    validators: [{
        nodeId: String,
        txHash: String,
        amountStaked: String,
        startTimestamp: Number,
        endTimestamp: Number,
        validationStatus: String,
        uptimePerformance: Number,
        avalancheGoVersion: String
    }],
    lastUpdated: { type: Date, default: Date.now },
    tps: {
        value: Number,
        timestamp: Number,
        lastUpdated: Date
    },
    cumulativeTxCount: {
        value: Number,
        timestamp: Number,
        lastUpdated: Date
    },
    categories: [String],
    website: String,
    socials: [{
        name: String,
        url: String
    }],
    network: {
        type: String,
        enum: ['mainnet', 'fuji', null],
        default: null
    },
    evmChainId: Number,
    rpcUrls: [String],
    assets: [{
        symbol: String,
        name: String,
        decimals: Number
    }],
    registryMetadata: {
        folderName: String,
        lastUpdated: Date,
        source: String
    }
});

// Add indexes for better query performance
chainSchema.index({ subnetId: 1 });
chainSchema.index({ blockchainId: 1 });
chainSchema.index({ isTestnet: 1 });
chainSchema.index({ status: 1 });
chainSchema.index({ 'validators.validationStatus': 1 });
chainSchema.index({ categories: 1 });
chainSchema.index({ network: 1 });
chainSchema.index({ evmChainId: 1 });

module.exports = mongoose.model('Chain', chainSchema);
