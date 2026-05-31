const GasUsed = require('../models/gasUsed');
const createMetricService = require('./metricService');

const service = createMetricService({
  model: GasUsed,
  metricPath: 'gasUsed',
  label: 'GasUsed',
  aggregation: 'sum'
});

// Preserve the original public method names so existing routes/cron callers
// continue to work unchanged.
module.exports = {
  updateGasUsedData: (chainId, retryCount) => service.updateData(chainId, retryCount),
  updateAllChainsGasUsed: () => service.updateAllChains(),
  getGasUsedHistory: (chainId, days) => service.getHistory(chainId, days),
  getLatestGasUsed: (chainId) => service.getLatest(chainId),
  getNetworkGasUsedHistory: (days) => service.getNetworkHistory(days),
  getNetworkLatestGasUsed: () => service.getNetworkLatest()
};
