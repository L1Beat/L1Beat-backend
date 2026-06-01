const AvgGasPrice = require('../models/avgGasPrice');
const createMetricService = require('./metricService');

const service = createMetricService({
  model: AvgGasPrice,
  metricPath: 'avgGasPrice',
  label: 'AvgGasPrice',
  // Gas price is averaged across chains for network-wide figures, not summed.
  aggregation: 'avg'
});

// Preserve the original public method names so existing routes/cron callers
// continue to work unchanged.
module.exports = {
  updateAvgGasPriceData: (chainId, retryCount) => service.updateData(chainId, retryCount),
  updateAllChainsAvgGasPrice: () => service.updateAllChains(),
  getAvgGasPriceHistory: (chainId, days) => service.getHistory(chainId, days),
  getLatestAvgGasPrice: (chainId) => service.getLatest(chainId),
  getNetworkAvgGasPriceHistory: (days) => service.getNetworkHistory(days),
  getNetworkLatestAvgGasPrice: () => service.getNetworkLatest()
};
