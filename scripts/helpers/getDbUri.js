require('dotenv').config();

/**
 * Get the appropriate MongoDB URI based on environment
 * Follows the same logic as src/config/config.js
 */
function getDbUri() {
  if (process.env.NODE_ENV === 'production') {
    return process.env.PROD_MONGODB_URI;
  }

  // Development: prefer LOCAL_MONGODB_URI, fallback to DEV_MONGODB_URI
  return process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;
}

module.exports = getDbUri;
