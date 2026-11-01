/**
 * Network history aggregation against the test DB: the Mongo pipeline must
 * match grouping the raw rows by day.
 */

require('./setup');
const MaxTps = require('../src/models/maxTps');
const AvgGasPrice = require('../src/models/avgGasPrice');
const maxTpsService = require('../src/services/maxTpsService');
const avgGasPriceService = require('../src/services/avgGasPriceService');

async function groupedRows(model, days, average) {
  const now = Math.floor(Date.now() / 1000);
  const rows = await model.find({ timestamp: { $gte: now - days * 24 * 60 * 60, $lte: now } }).lean();
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.timestamp) || { timestamp: r.timestamp, value: 0, chainCount: 0 };
    g.value += r.value;
    g.chainCount += 1;
    groups.set(r.timestamp, g);
  }
  return [...groups.values()]
    .map(g => ({ ...g, value: average ? g.value / g.chainCount : g.value }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function expectSameSeries(actual, expected) {
  expect(actual.map(r => [r.timestamp, r.chainCount])).toEqual(expected.map(r => [r.timestamp, r.chainCount]));
  actual.forEach((r, i) => expect(r.value).toBeCloseTo(expected[i].value, 6));
}

describe('network history aggregation', () => {
  it('sums per day like grouping the raw rows (max TPS)', async () => {
    expectSameSeries(await maxTpsService.getNetworkMaxTpsHistory(90), await groupedRows(MaxTps, 90, false));
  });

  it('averages per day like grouping the raw rows (avg gas price)', async () => {
    expectSameSeries(await avgGasPriceService.getNetworkAvgGasPriceHistory(90), await groupedRows(AvgGasPrice, 90, true));
  });
});
