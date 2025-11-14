/**
 * Test setup and helper utilities
 */

// Set test environment before importing app
process.env.NODE_ENV = 'test';
process.env.PORT = '5002'; // Use different port for tests

// Mock tpsService before importing app to prevent actual API calls
// Return proper data structures that endpoints expect
jest.mock('../src/services/tpsService', () => ({
  updateTpsData: jest.fn().mockResolvedValue(null),
  getTpsHistory: jest.fn().mockResolvedValue([
    { timestamp: Math.floor(Date.now() / 1000) - 86400, value: 10.5 },
    { timestamp: Math.floor(Date.now() / 1000) - 172800, value: 12.3 }
  ]),
  getLatestTps: jest.fn().mockResolvedValue({
    timestamp: Math.floor(Date.now() / 1000),
    value: 15.7
  }),
  getNetworkTps: jest.fn().mockResolvedValue({
    totalTps: 250.5,
    chainCount: 10,
    timestamp: Math.floor(Date.now() / 1000),
    dataAge: 5,
    dataAgeUnit: 'minutes'
  }),
  getNetworkTpsHistory: jest.fn().mockResolvedValue([
    { timestamp: Math.floor(Date.now() / 1000) - 86400, totalTps: 240.5, chainCount: 10 },
    { timestamp: Math.floor(Date.now() / 1000) - 172800, totalTps: 235.2, chainCount: 9 }
  ]),
  updateCumulativeTxCount: jest.fn().mockResolvedValue(null),
  getTxCountHistory: jest.fn().mockResolvedValue([
    { timestamp: Math.floor(Date.now() / 1000) - 86400, value: 1000000 },
    { timestamp: Math.floor(Date.now() / 1000) - 172800, value: 950000 }
  ]),
  getLatestTxCount: jest.fn().mockResolvedValue({
    timestamp: Math.floor(Date.now() / 1000),
    value: 1050000
  })
}));

const request = require('supertest');
const app = require('../src/app');

/**
 * Helper to make GET requests
 */
const get = (url) => request(app).get(url);

/**
 * Helper to make POST requests
 */
const post = (url) => request(app).post(url);

/**
 * Helper to make PUT requests
 */
const put = (url) => request(app).put(url);

/**
 * Helper to make DELETE requests
 */
const deleteRequest = (url) => request(app).delete(url);

/**
 * Wait helper for async operations
 */
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  app,
  request,
  get,
  post,
  put,
  deleteRequest,
  wait
};
