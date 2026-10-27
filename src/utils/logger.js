const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Safe JSON stringify that handles circular references
const safeStringify = (obj, indent = 2) => {
  let cache = [];
  const retVal = JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === 'object' && value !== null) {
        // Check for circular reference
        if (cache.includes(value)) {
          return '[Circular Reference]';
        }
        cache.push(value);
      }
      return value;
    },
    indent
  );
  cache = null; // Enable garbage collection
  return retVal;
};

// Define log format
const logFormat = winston.format.printf(({ level, message, timestamp, ...rest }) => {
  let logMessage = `${timestamp} ${level}: ${message}`;
  
  // Add additional metadata if present
  if (Object.keys(rest).length > 0) {
    try {
      logMessage += ` ${safeStringify(rest)}`;
    } catch (error) {
      logMessage += ` [Error serializing log metadata: ${error.message}]`;
    }
  }
  
  return logMessage;
});

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    logFormat
  ),
  defaultMeta: { service: 'l1beat-backend' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        logFormat
      )
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error',
      maxsize: 10 * 1024 * 1024, // rotate at 10MB, keep 5 files
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5
    })
  ]
});

// Log that file logging is enabled
logger.info('File logging enabled');

// Create a stream object for Morgan
logger.stream = {
  write: (message) => {
    logger.http(message.trim());
  }
};

module.exports = logger; 