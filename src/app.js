require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config/config');
const connectDB = require('./config/db');
const chainRoutes = require('./routes/chainRoutes');
const fetchAndUpdateData = require('./utils/fetchGlacierData');
const chainDataService = require('./services/chainDataService');
const Chain = require('./models/chain');
const chainService = require('./services/chainService');
const tpsRoutes = require('./routes/tpsRoutes');
const tpsService = require('./services/tpsService');
const TPS = require('./models/tps');
const activeAddressesRoutes = require('./routes/activeAddressesRoutes');
const activeAddressesService = require('./services/activeAddressesService');
const txCountRoutes = require('./routes/txCountRoutes');
const txCountService = require('./services/txCountService');
const maxTpsRoutes = require('./routes/maxTpsRoutes');
const maxTpsService = require('./services/maxTpsService');
const cumulativeTxCountRoutes = require('./routes/cumulativeTxCountRoutes');
const gasUsedRoutes = require('./routes/gasUsedRoutes');
const gasUsedService = require('./services/gasUsedService');
const avgGasPriceRoutes = require('./routes/avgGasPriceRoutes');
const avgGasPriceService = require('./services/avgGasPriceService');
const feesPaidRoutes = require('./routes/feesPaidRoutes');
const feesPaidService = require('./services/feesPaidService');
const teleporterRoutes = require('./routes/teleporterRoutes');
const logger = require('./utils/logger');
const blogRoutes = require('./routes/blogRoutes');
const authorRoutes = require('./routes/authorRoutes');
const authorService = require('./services/authorService');
const snowpeerRoutes = require('./routes/snowpeerRoutes');
const substackService = require('./services/substackService');


const app = express();

// Check if we're running on Vercel
const isVercel = process.env.VERCEL === '1';

// Trust proxy when running on Vercel or other cloud platforms
if (isVercel || config.isProduction) {
  logger.info('Running behind a proxy, setting trust proxy to true');
  app.set('trust proxy', 1);
}

// Add debugging logs
logger.info('Starting server', {
  environment: config.env,
  mongoDbUri: config.isProduction
    ? 'PROD URI is set: ' + !!process.env.PROD_MONGODB_URI
    : 'DEV URI is set: ' + !!process.env.DEV_MONGODB_URI
});

// Environment-specific configurations
const isDevelopment = config.env === 'development';

// Add security headers
app.use(helmet());

// Rate limiting middleware
const apiLimiter = rateLimit(config.rateLimit);

// Apply rate limiting to all API routes
app.use('/api', apiLimiter);

// CORS middleware with environment-aware settings
const corsOrigins = config.cors.origin;
logger.info('Using CORS settings', { 
  environment: config.env,
  origins: corsOrigins,
  frontendUrl: process.env.FRONTEND_URL 
});

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return callback(null, true);
    
    // Check if origin is in allowed list
    if (corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // Allow localhost and container-based origins in development
    if (config.env === 'development' && origin.includes('localhost')) {
      return callback(null, true);
    }
    
    // Allow Bolt.new webcontainer URLs
    if (origin.match(/^https:\/\/.*\.webcontainer-api\.io$/)) {
      return callback(null, true);
    }
    
    // Log blocked origins for debugging
    logger.warn('CORS blocked origin:', { origin, allowedOrigins: corsOrigins });
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Cache-Control'
  ]
}));

app.use(express.json());

// Health check endpoint - MUST be before DB connection for deployment health checks
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Single initialization point for data updates
const initializeDataUpdates = async () => {
  logger.info(`[${config.env}] Initializing data updates at ${new Date().toISOString()}`);

  try {
    // First, load the registry
    logger.info('[REGISTRY] Loading l1-registry data...');
    const registryService = require('./services/registryService');
    const registryChains = await registryService.loadAllChains();
    logger.info(`[REGISTRY] Loaded ${registryChains.length} chains from l1-registry`);

    // Sync registry data to database
    logger.info('[REGISTRY] Syncing registry data to database...');
    await registryService.syncToDatabase(Chain);
    logger.info('[REGISTRY] Registry sync complete');

    // Then fetch and enrich with Glacier data
    logger.info('Fetching initial chain data from Glacier...');
    const chains = await chainDataService.fetchChainData();
    logger.info(`Fetched ${chains.length} chains from Glacier API`);

    if (chains && chains.length > 0) {
      for (const chain of chains) {
        await chainService.updateChain(chain);

        // Use evmChainId if available (registry chains), otherwise use chainId (Glacier chains)
        const chainIdForTps = chain.evmChainId || chain.chainId;

        // Only fetch TPS/TxCount if we have a valid numeric chain ID
        if (chainIdForTps && /^\d+$/.test(String(chainIdForTps))) {
          // Add initial TPS update for each chain
          await tpsService.updateTpsData(String(chainIdForTps));
          // Add initial Transaction Count update for each chain
          await tpsService.updateCumulativeTxCount(String(chainIdForTps));
          // Add initial Gas Used update for each chain
          await gasUsedService.updateGasUsedData(String(chainIdForTps));
          // Add initial Average Gas Price update for each chain
          await avgGasPriceService.updateAvgGasPriceData(String(chainIdForTps));
          // Add initial Fees Paid update for each chain
          await feesPaidService.updateFeesPaidData(String(chainIdForTps));
        } else {
          logger.debug(`Skipping TPS/TxCount fetch for chain ${chain.chainName || chain.chainId} - no valid numeric chain ID`);
        }
      }
      logger.info(`Updated ${chains.length} chains in database`);

      // Verify chains were saved
      const savedChains = await Chain.find();
      logger.info('Chains in database:', {
        count: savedChains.length,
        chainIds: savedChains.map(c => c.chainId)
      });
    } else {
      logger.error('No chains fetched from Glacier API');
    }

    // Initialize default authors from config
    logger.info('[AUTHOR INIT] Initializing default authors...');
    try {
      await authorService.initializeDefaultAuthors();
      logger.info('[AUTHOR INIT] Default authors initialization completed');
    } catch (error) {
      logger.error('[AUTHOR INIT] Error initializing default authors:', {
        message: error.message,
        stack: error.stack
      });
    }

    // Initial blog sync
    logger.info('[BLOG INIT] Updating initial blog data...');
    try {
      await substackService.syncArticles('initial-sync');
      logger.info('[BLOG INIT] Blog data initialization completed');
    } catch (error) {
      logger.error('[BLOG INIT] Error initializing blog data:', {
        message: error.message,
        stack: error.stack
      });
    }

    // Initial teleporter data update
    logger.info('[TELEPORTER INIT] Updating initial daily teleporter data...');
    const teleporterService = require('./services/teleporterService');
    await teleporterService.updateTeleporterData();

    // Initialize weekly data if needed
    if (config.initWeeklyData) {
      logger.info('[TELEPORTER INIT] Initializing weekly teleporter data...');
      (async () => {
        try {
          // Update weekly data
          await teleporterService.updateWeeklyData();
          logger.info('[TELEPORTER INIT] Weekly data initialization completed');
        } catch (error) {
          logger.error('[TELEPORTER INIT] Error initializing weekly data:', {
            message: error.message,
            stack: error.stack
          });
        }
      })();
    }

  } catch (error) {
    logger.error('Initialization error:', error);
  }

  // Set up scheduled updates for both production and development
  logger.info('Setting up update schedules...');

  // Chain and TPS updates every hour
  cron.schedule(config.cron.chainUpdate, async () => {
    try {
      logger.info(`[CRON] Starting scheduled chain update at ${new Date().toISOString()}`);
      const chains = await chainDataService.fetchChainData();
      for (const chain of chains) {
        await chainService.updateChain(chain);

        // Use evmChainId if available (registry chains), otherwise use chainId (Glacier chains)
        const chainIdForTps = chain.evmChainId || chain.chainId;

        // Only fetch TPS/TxCount if we have a valid numeric chain ID
        if (chainIdForTps && /^\d+$/.test(String(chainIdForTps))) {
          // Add TPS update for each chain
          await tpsService.updateTpsData(String(chainIdForTps));
          // Add Max TPS update for each chain
          await maxTpsService.updateMaxTpsData(String(chainIdForTps));
          // Add Cumulative Transaction Count update for each chain
          await tpsService.updateCumulativeTxCount(String(chainIdForTps));
          // Add Daily Transaction Count update for each chain
          await txCountService.updateTxCountData(String(chainIdForTps));
          // Add Active Addresses update for each chain
          await activeAddressesService.updateActiveAddressesData(String(chainIdForTps));
          // Add Gas Used update for each chain
          await gasUsedService.updateGasUsedData(String(chainIdForTps));
          // Add Average Gas Price update for each chain
          await avgGasPriceService.updateAvgGasPriceData(String(chainIdForTps));
          // Add Fees Paid update for each chain
          await feesPaidService.updateFeesPaidData(String(chainIdForTps));
        }
      }
      logger.info(`[CRON] Updated ${chains.length} chains with TPS, Max TPS, TxCount, Active Addresses, Gas Used, Avg Gas Price, Fees Paid, and Cumulative TxCount data`);
    } catch (error) {
      logger.error('[CRON] Chain/TPS/TxCount update failed:', error);
    }
  });

  // Teleporter data updates every hour
  cron.schedule(config.cron.teleporterUpdate, async () => {
    try {
      logger.info(`[CRON TELEPORTER DAILY] Starting scheduled daily teleporter update at ${new Date().toISOString()}`);
      const teleporterService = require('./services/teleporterService');
      await teleporterService.updateTeleporterData();
      logger.info('[CRON TELEPORTER DAILY] Daily teleporter update completed');
    } catch (error) {
      logger.error('[CRON TELEPORTER DAILY] Daily teleporter update failed:', error);
    }
  });

  // Blog RSS sync every 12 hours
  cron.schedule(config.cron.blogSync, async () => {
    try {
      logger.info(`[CRON BLOG] Starting scheduled blog sync at ${new Date().toISOString()}`);
      const result = await substackService.syncArticles('scheduled-sync');
      logger.info('[CRON BLOG] Blog sync completed:', result);
    } catch (error) {
      logger.error('[CRON BLOG] Blog sync failed:', error);
    }
  });

  // Weekly teleporter data updates once a day
  cron.schedule('0 0 * * *', async () => {
    try {
      logger.info(`[CRON TELEPORTER WEEKLY] Starting scheduled weekly teleporter update at ${new Date().toISOString()}`);
      const teleporterService = require('./services/teleporterService');

      // Check if there's already an update in progress
      const { TeleporterUpdateState, TeleporterMessage } = require('./models/teleporterMessage');
      const existingUpdate = await TeleporterUpdateState.findOne({
        updateType: 'weekly',
        state: 'in_progress'
      });

      if (existingUpdate) {
        logger.info('[CRON TELEPORTER WEEKLY] Weekly teleporter update already in progress, skipping scheduled update');
        return;
      }

      await teleporterService.updateWeeklyData();
      logger.info('[CRON TELEPORTER WEEKLY] Weekly teleporter update completed');
    } catch (error) {
      logger.error('[CRON TELEPORTER WEEKLY] Weekly teleporter update failed:', error);
    }
  });

  // Registry sync once a day at 3 AM
  cron.schedule('0 3 * * *', async () => {
    try {
      logger.info(`[CRON REGISTRY] Starting scheduled registry sync at ${new Date().toISOString()}`);
      const registryService = require('./services/registryService');
      const registryChains = await registryService.loadAllChains();
      await registryService.syncToDatabase(Chain);
      logger.info(`[CRON REGISTRY] Registry sync completed - synced ${registryChains.length} chains`);
    } catch (error) {
      logger.error('[CRON REGISTRY] Registry sync failed:', error);
    }
  });
};

// Call initialization after DB connection (skip in test mode)
const isTestMode = process.env.NODE_ENV === 'test';
connectDB().then(async () => {
  if (!isTestMode) {
    // First, check for and fix any stale teleporter updates
    await fixStaleUpdates();

    // Then continue with normal initialization
    initializeDataUpdates();
  } else {
    logger.info('Skipping background data updates in test mode');
  }
});

/**
 * Helper function to check for and fix any stale teleporter updates
 * This ensures we don't get stuck with in_progress updates that never complete
 */
async function fixStaleUpdates() {
  try {
    logger.info('Checking for stale teleporter updates on startup...');

    // Import required models
    const { TeleporterUpdateState } = require('./models/teleporterMessage');

    // Find any in_progress updates
    const staleUpdates = await TeleporterUpdateState.find({
      state: 'in_progress'
    });

    if (staleUpdates.length > 0) {
      logger.warn(`Found ${staleUpdates.length} stale teleporter updates on startup, marking as failed`, {
        updates: staleUpdates.map(u => ({
          type: u.updateType,
          startedAt: u.startedAt,
          lastUpdatedAt: u.lastUpdatedAt,
          timeSinceLastUpdate: Math.round((Date.now() - new Date(u.lastUpdatedAt).getTime()) / (60 * 1000)) + ' minutes'
        }))
      });

      // Mark all stale updates as failed
      for (const update of staleUpdates) {
        update.state = 'failed';
        update.lastUpdatedAt = new Date();
        update.error = {
          message: 'Update timed out (found on server startup)',
          details: `Update was still in_progress state when server restarted`
        };
        await update.save();
        logger.info(`Marked stale ${update.updateType} update as failed`, {
          startedAt: update.startedAt,
          lastUpdatedAt: update.lastUpdatedAt
        });
      }
    } else {
      logger.info('No stale teleporter updates found on startup');
    }
  } catch (error) {
    logger.error('Error checking for stale updates:', error);
  }
}

// Routes
app.use('/api', chainRoutes);
app.use('/api', tpsRoutes);
app.use('/api', maxTpsRoutes);
app.use('/api', activeAddressesRoutes);
app.use('/api', txCountRoutes);
app.use('/api', gasUsedRoutes);
app.use('/api', avgGasPriceRoutes);
app.use('/api', feesPaidRoutes);
app.use('/api', cumulativeTxCountRoutes);
app.use('/api', teleporterRoutes);
app.use('/api', blogRoutes);
app.use('/api/authors', authorRoutes);
app.use('/api/snowpeer', snowpeerRoutes);

// Cache status endpoint (development only)
if (isDevelopment) {
  const cacheManager = require('./utils/cacheManager');
  app.get('/api/cache/status', (req, res) => {
    res.json({
      stats: cacheManager.getStats(),
      environment: config.env,
      timestamp: new Date().toISOString()
    });
  });
}

// Development-only middleware
if (isDevelopment) {
  app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.path}`, { timestamp: new Date().toISOString() });
    next();
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Error:', { message: err.message, stack: err.stack, path: req.path });

  // Send proper JSON response
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    path: req.path
  });
});

// Add catch-all route for undefined routes
app.use('*', (req, res) => {
  logger.warn('Not Found:', { path: req.path, method: req.method });
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource was not found',
    path: req.path
  });
});

const PORT = process.env.PORT || 5001;

// Check for required environment variables before starting
const requiredEnvVars = [
  'GLACIER_API_BASE',
  'METRICS_API_BASE'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  logger.error('Missing required environment variables:', {
    missing: missingEnvVars.join(', ')
  });
  logger.error('Please check your .env file and make sure these variables are set.');
  // Still allow the server to start (for development convenience)
}

// For Vercel, we need to export the app
module.exports = app;

// Only listen if not running on Vercel or in test mode
const isTest = process.env.NODE_ENV === 'test';
if (!isVercel && !isTest) {
  const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`, {
      environment: config.env,
      port: PORT,
      timestamp: new Date().toISOString()
    });
    logger.info(`Try accessing: http://localhost:${PORT}/api/chains`);
  });

  // Add error handler for the server
  server.on('error', (error) => {
    logger.error('Server error:', { error: error.message, stack: error.stack });
  });
}
