const TxCount = require('../models/txCount');
const createMetricService = require('./metricService');

const service = createMetricService({
  model: TxCount,
  metricPath: 'txCount',
  label: 'TxCount',
  aggregation: 'sum'
});

// Preserve the original public method names so existing routes/cron callers
// continue to work unchanged.
module.exports = {
  updateTxCountData: (chainId, retryCount) => service.updateData(chainId, retryCount),
  updateAllChainsTxCount: () => service.updateAllChains(),
  getTxCountHistory: (chainId, days) => service.getHistory(chainId, days),
  getLatestTxCount: (chainId) => service.getLatest(chainId),
  getNetworkTxCountHistory: (days) => service.getNetworkHistory(days),
  getNetworkLatestTxCount: () => service.getNetworkLatest()
};
