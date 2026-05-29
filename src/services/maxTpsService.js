const MaxTps = require('../models/maxTps');
const createMetricService = require('./metricService');

const service = createMetricService({
  model: MaxTps,
  metricPath: 'maxTps',
  label: 'MaxTps',
  aggregation: 'sum'
});

// Preserve the original public method names so existing routes/cron callers
// continue to work unchanged.
module.exports = {
  updateMaxTpsData: (chainId, retryCount) => service.updateData(chainId, retryCount),
  updateAllChainsMaxTps: () => service.updateAllChains(),
  getMaxTpsHistory: (chainId, days) => service.getHistory(chainId, days),
  getLatestMaxTps: (chainId) => service.getLatest(chainId),
  getNetworkMaxTpsHistory: (days) => service.getNetworkHistory(days),
  getNetworkLatestMaxTps: () => service.getNetworkLatest()
};
