const crypto = require("crypto");
const config = require("../config/config");
const logger = require("./logger");

// Constant-time comparison so the key can't be recovered via response timing.
const keysMatch = (provided, expected) => {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Require a matching `x-api-key` header. `keyName` selects an entry from
// config.apiKeys (e.g. 'update', 'admin'). Fails closed: if the key isn't
// configured, the endpoint is disabled rather than left open.
const requireApiKey = (keyName) => {
  return (req, res, next) => {
    const expected = config.apiKeys[keyName];
    if (!expected) {
      logger.error(`API key '${keyName}' is not configured; rejecting request`, { path: req.path });
      return res.status(503).json({ success: false, error: "Endpoint not configured" });
    }

    const provided = req.get("x-api-key");
    if (!provided || !keysMatch(provided, expected)) {
      logger.warn("Rejected request with missing or invalid API key", { path: req.path, ip: req.ip });
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    next();
  };
};

module.exports = { requireApiKey };
