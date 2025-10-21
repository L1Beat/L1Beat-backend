/**
 * Test setup and helper utilities
 */

// Set test environment before importing app
process.env.NODE_ENV = 'test';
process.env.PORT = '5002'; // Use different port for tests

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
