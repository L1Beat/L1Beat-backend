const ActiveAddresses = require('../models/activeAddresses');
const createMetricService = require('./metricService');

const service = createMetricService({
  model: ActiveAddresses,
  metricPath: 'activeAddresses',
  label: 'Active Addresses',
  aggregation: 'sum'
});

// Preserve the original public method names so existing routes/cron callers
// continue to work unchanged.
module.exports = {
  updateActiveAddressesData: (chainId, retryCount) => service.updateData(chainId, retryCount),
  updateAllChainsActiveAddresses: () => service.updateAllChains(),
  getActiveAddressesHistory: (chainId, days) => service.getHistory(chainId, days),
  getLatestActiveAddresses: (chainId) => service.getLatest(chainId),
  getNetworkActiveAddressesHistory: (days) => service.getNetworkHistory(days),
  getNetworkLatestActiveAddresses: () => service.getNetworkLatest()
};
