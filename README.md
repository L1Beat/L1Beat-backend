# L1Beat Backend

A Node.js backend service for the L1Beat, providing API endpoints for Avalanche L1 data and metrics.

## Features

- **Chain Data**: Fetch and store information about Avalanche chains
- **Validator Data**: Track validators for each chain
- **TPS Metrics**: Track transactions per second for each chain and the entire network
- **Caching**: In-memory caching for improved performance
- **Structured Logging**: Comprehensive logging system
- **Security**: Rate limiting, input validation, and security headers

## Tech Stack

- **Node.js** and **Express**: Backend framework
- **MongoDB**: Database for storing chain, validator, and TPS data
- **Mongoose**: MongoDB object modeling
- **Winston**: Structured logging
- **Helmet**: Security headers
- **Express Validator**: Input validation
- **Express Rate Limit**: API rate limiting
- **Node-cron**: Scheduled tasks

## API Endpoints

### Chain Endpoints

- `GET /api/chains`: Get all chains
- `GET /api/chains/:chainId`: Get a specific chain by ID
- `GET /api/chains/:chainId/validators`: Get validators for a specific chain

### TPS Endpoints

- `GET /api/chains/:chainId/tps/history`: Get TPS history for a specific chain
- `GET /api/chains/:chainId/tps/latest`: Get latest TPS for a specific chain
- `GET /api/tps/network/latest`: Get latest network-wide TPS
- `GET /api/tps/network/history`: Get historical network-wide TPS
- `GET /api/tps/health`: Check TPS data health
- `GET /api/tps/diagnostic`: Get diagnostic information about TPS data
- `GET /api/tps/status`: Get TPS status summary

## Setup

### Prerequisites

- Node.js (v16.20.1 or higher)
- MongoDB

### Installation

1. Clone the repository:
   ```
   git clone https://github.com/L1Beat/L1Beat-backend.git
   cd l1beat-backend
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file in the root directory with the following variables:
   ```
   # Development Database
   DEV_MONGODB_URI=mongodb://localhost:27017/glacier-chains
   PROD_MONGODB_URI=mongodb+srv://[username]:[password]@your-mongodb-cluster/glacier-chains

   NODE_ENV=development
   PORT=5001

   ADMIN_API_KEY=your-admin-key
   UPDATE_API_KEY=your-update-key

   # Frontend URLs
   FRONTEND_URL=http://localhost:5173
   ```

4. Start the development server:
   ```
   npm run dev
   ```

### Production Deployment

The application runs as a long-lived Node.js process on DigitalOcean (it relies
on in-process `node-cron` jobs and long-running background updates, so it must
run as a persistent process — not a serverless function).

1. Set the production environment variables (e.g. via a `.env` file or the
   process environment):
   ```
   NODE_ENV=production
   PROD_MONGODB_URI=your_production_mongodb_uri
   ADMIN_API_KEY=your_production_admin_key
   UPDATE_API_KEY=your_production_update_key
   ```

2. Install dependencies and start the server:
   ```
   npm ci
   npm start
   ```

Run it under a process manager (e.g. PM2 or a systemd unit) so it restarts on
crash, and place it behind a reverse proxy / load balancer (the app sets
`trust proxy` in production). On `SIGTERM`/`SIGINT` the server shuts down
gracefully, draining in-flight requests and closing the MongoDB connection.

## Scheduled Tasks

The application runs several scheduled tasks:

- Chain and TPS updates: Every hour

## Caching

The application implements in-memory caching for frequently accessed data:

- Chain data: 5 minutes
- TPS data: 5 minutes

## Security

The application implements several security measures:

- Rate limiting for API endpoints
- Input validation for all parameters
- Security headers via Helmet
- CORS configuration

## License

ISC

## Environment Variables

The following environment variables are required for the application to function properly:

### Server Configuration
- `PORT` - The port on which the server will run (default: 5001)
- `HOST` - The host on which the server will run (default: 0.0.0.0)
- `NODE_ENV` - The environment in which the application is running (development/production)

### Database Configuration
- `DEV_MONGODB_URI` - MongoDB connection URI for development environment
- `PROD_MONGODB_URI` - MongoDB connection URI for production environment

### API Keys
- `GLACIER_API_KEY` - API key for Glacier API with increased rate limits

### External API Configuration
- `GLACIER_API_BASE` - Base URL for the Glacier API
- `GLACIER_API_TIMEOUT` - Timeout for Glacier API requests in milliseconds (default: 30000)
- `GLACIER_VALIDATORS_ENDPOINT` - Endpoint for validators (default: /networks/mainnet/validators)
- `GLACIER_L1VALIDATORS_ENDPOINT` - Endpoint for L1Validators (default: /networks/mainnet/l1Validators)

- `METRICS_API_BASE` - Base URL for the Metrics API
- `METRICS_API_TIMEOUT` - Timeout for Metrics API requests in milliseconds (default: 30000)
- `METRICS_RATE_LIMIT` - Rate limit for Metrics API requests per minute (default: 20)
- `METRICS_RETRY_DELAY` - Delay before retrying Metrics API requests in milliseconds (default: 2000)
- `METRICS_MAX_RETRIES` - Maximum number of retries for Metrics API requests (default: 3)

### Glacier API Rate Limiting (Optional)
- `GLACIER_RATE_LIMIT` - Limit for Glacier API requests per minute (default: 10)
- `GLACIER_RETRY_DELAY` - Initial delay before retrying Glacier API requests in milliseconds (default: 5000)
- `GLACIER_MAX_RETRIES` - Maximum number of retries for Glacier API requests (default: 5)
- `GLACIER_MIN_DELAY` - Minimum delay between Glacier API requests in milliseconds (default: 2000) 