/**
 * Central configuration module
 * All configuration values should be defined here
 */
const config = {
  // Environment
  env: process.env.NODE_ENV || "development",
  isDevelopment: process.env.NODE_ENV === "development",
  isProduction: process.env.NODE_ENV === "production",

  // Server
  server: {
    port: parseInt(process.env.PORT || "5001"),
    host: process.env.HOST || "0.0.0.0",
  },

  // Database
  db: {
    uri:
      process.env.NODE_ENV === "production"
        ? process.env.PROD_MONGODB_URI
        : process.env.DEV_MONGODB_URI,
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  },

  // API Keys
  apiKeys: {
    admin: process.env.ADMIN_API_KEY,
    update: process.env.UPDATE_API_KEY,
  },

  // External APIs
  api: {
    glacier: {
      baseUrl: process.env.GLACIER_API_BASE,
      apiKey: process.env.GLACIER_API_KEY, // API key for increased rate limits
      timeout: parseInt(process.env.GLACIER_API_TIMEOUT || "30000"),
      endpoints: {
        validators:
          process.env.GLACIER_VALIDATORS_ENDPOINT ||
          "/networks/mainnet/validators",
        l1Validators:
          process.env.GLACIER_L1VALIDATORS_ENDPOINT ||
          "/networks/mainnet/l1Validators",
      },
      rateLimit: {
        requestsPerMinute: parseInt(process.env.GLACIER_RATE_LIMIT || "10"), // Conservative limit by default
        retryDelay: parseInt(process.env.GLACIER_RETRY_DELAY || "5000"), // Start with 5s delay
        maxRetries: parseInt(process.env.GLACIER_MAX_RETRIES || "5"), // Match the MAX_RETRIES in TeleporterService
        minDelayBetweenRequests: parseInt(
          process.env.GLACIER_MIN_DELAY || "2000"
        ), // At least 2s between requests
      },
    },
    metrics: {
      baseUrl: process.env.METRICS_API_BASE,
      timeout: parseInt(process.env.METRICS_API_TIMEOUT || "30000"),
      rateLimit: {
        requestsPerMinute: parseInt(process.env.METRICS_RATE_LIMIT || "20"),
        retryDelay: parseInt(process.env.METRICS_RETRY_DELAY || "2000"),
        maxRetries: parseInt(process.env.METRICS_MAX_RETRIES || "3"),
      },
    },
    // Alternative validator endpoints for chains that don't use Glacier or need custom endpoints
    alternativeValidators: {
      // Define endpoints for specific chains that need alternative validator sources
      // Format: 'chainId': 'API endpoint URL'
      // Example: 'mychain': 'https://api.mychain.com/validators'
    },
    snowpeer: {
      baseUrl: process.env.SNOWPEER_API_BASE || "https://api.snowpeer.io/v1",
      timeout: parseInt(process.env.SNOWPEER_API_TIMEOUT || "30000"),
      rateLimit: {
        requestsPerMinute: parseInt(process.env.SNOWPEER_RATE_LIMIT || "20"),
        retryDelay: parseInt(process.env.SNOWPEER_RETRY_DELAY || "2000"),
        maxRetries: parseInt(process.env.SNOWPEER_MAX_RETRIES || "3"),
      },
    },
  },

  // CORS
  cors: {
    origin:
      process.env.NODE_ENV === "development"
        ? ["http://localhost:5173", "http://localhost:4173"]
        : [
            "https://l1beat.io",
            "https://www.l1beat.io",
            "http://localhost:4173",
            "http://localhost:5173",
            process.env.FRONTEND_URL,
          ].filter(Boolean),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
      "Cache-Control",
    ],
  },

  // Rate limiting
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: process.env.NODE_ENV === "development" ? 1000 : 100, // Higher limit in development
    standardHeaders: true,
    legacyHeaders: false,
    // Skip client IP validation when running behind a proxy
    validate: { xForwardedForHeader: false },
  },

  // Cron schedules
  cron: {
    chainUpdate: "0 * * * *", // Every hour
    tpsVerification: "*/15 * * * *", // Every 15 minutes
    teleporterUpdate: "0 * * * *", // Every hour
  },

  // Cache TTLs (in milliseconds)
  cache: {
    chains: 5 * 60 * 1000, // 5 minutes
    tps: 5 * 60 * 1000, // 5 minutes
    txCount: 5 * 60 * 1000, // 5 minutes
    teleporter: 5 * 60 * 1000, // 5 minutes
  },

  // Blog/Substack integration
  blog: {
    rssUrl: process.env.SUBSTACK_RSS_URL || "https://l1beat.substack.com/feed",
    timeout: parseInt(process.env.BLOG_API_TIMEOUT || "30000"),
    syncInterval: parseInt(process.env.BLOG_SYNC_INTERVAL || "3600000"), //an hour in milllie
    rateLimit: {
      requestsPerHour: parseInt(process.env.BLOG_RATE_LIMIT || "10"),
      retryDelay: parseInt(process.env.BLOG_RETRY_DELAY || "5000"),
      maxRetries: parseInt(process.env.BLOG_MAX_RETRIES || "3"),
    },
  },

  // Update your existing cron object:
  cron: {
    chainUpdate: "0 * * * *", // Every hour
    tpsVerification: "*/15 * * * *", // Every 15 minutes
    teleporterUpdate: "0 * * * *", // Every hour
    blogSync: "0 */12 * * *", // Every 12 hours
  },

  // Update your existing cache object:
  cache: {
    chains: 5 * 60 * 1000, // 5 minutes
    tps: 5 * 60 * 1000, // 5 minutes
    txCount: 5 * 60 * 1000, // 5 minutes
    teleporter: 5 * 60 * 1000, // 5 minutes
    blog: 10 * 60 * 1000, // 10 minutes
    snowpeer: 5 * 60 * 1000, // 5 minutes
  },
};

module.exports = config;
