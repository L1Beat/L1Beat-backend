const FeesPaid = require('../models/feesPaid');
const createMetricService = require('./metricService');

const service = createMetricService({
  model: FeesPaid,
  metricPath: 'feesPaid',
  label: 'FeesPaid',
  aggregation: 'sum'
});

// Preserve the original public method names so existing routes/cron callers
// continue to work unchanged.
module.exports = {
  updateFeesPaidData: (chainId, retryCount) => service.updateData(chainId, retryCount),
  updateAllChainsFeesPaid: () => service.updateAllChains(),
  getFeesPaidHistory: (chainId, days) => service.getHistory(chainId, days),
  getLatestFeesPaid: (chainId) => service.getLatest(chainId),
  getNetworkFeesPaidHistory: (days) => service.getNetworkHistory(days),
  getNetworkLatestFeesPaid: () => service.getNetworkLatest()
};
