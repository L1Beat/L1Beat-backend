# L1Beat Backend - Local Testing Instructions

This document provides instructions for setting up and testing the L1Beat backend locally.

## Prerequisites

- Node.js (v16.20.1 or higher)
- Docker (for running MongoDB locally)
- npm

## Setup Steps

### 1. Clone the Repository

```bash
git clone https://github.com/L1Beat/L1Beat-backend.git
cd L1Beat-backend
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start MongoDB with Docker

```bash
docker run -d --name mongodb -p 27017:27017 mongo:latest
```

To verify MongoDB is running:
```bash
docker ps | grep mongo
```

### 4. Create Environment File

Create a `.env` file in the root directory:

```bash
# Development Database
DEV_MONGODB_URI=mongodb://localhost:27017/l1beat

NODE_ENV=development
PORT=5001

# Frontend URLs
FRONTEND_URL=http://localhost:5173

# For development
PROD_MONGODB_URI=mongodb://localhost:27017/l1beat

# API Endpoints
GLACIER_API_BASE=https://glacier-api.avax.network/v1
GLACIER_API_TIMEOUT=60000

DEFILLAMA_API_BASE=https://api.llama.fi/v2
DEFILLAMA_API_TIMEOUT=30000

# New Metrics API
METRICS_API_BASE=https://metrics.avax.network/v2
METRICS_API_TIMEOUT=30000

# Blogs
SUBSTACK_RSS_URL=https://l1beat.substack.com/feed
BLOG_API_TIMEOUT=30000
BLOG_SYNC_INTERVAL=3600000
BLOG_RATE_LIMIT=10
```

### 5. Start the Development Server

```bash
npm run dev
```

The server will start on port 5001 and begin initializing data from the Glacier API.

## Testing Endpoints

### Health Check
```bash
curl http://localhost:5001/health
```
Expected response: `{"status":"ok"}`

### Get All Chains
```bash
curl http://localhost:5001/api/chains
```

### Get Network TPS (Latest)
```bash
curl http://localhost:5001/api/tps/network/latest
```
Expected response includes: `totalTps`, `chainCount`, `timestamp`, `updatedAt`

### Get Network TPS History
```bash
curl http://localhost:5001/api/tps/network/history
```

### Get Chain-specific TPS
```bash
curl http://localhost:5001/api/chains/43114/tps/latest
```

## Verifying PR #70 Changes

The PR removes a redundant database query in `getNetworkTps()`. To verify:

1. Start the server with `npm run dev`
2. Call the network TPS endpoint: `curl http://localhost:5001/api/tps/network/latest`
3. Check the server logs

**Before the fix**, you would see these log messages:
- "Network TPS calculation - Time boundaries"
- "All TPS records in last 24h" (REDUNDANT - fetched all records for debugging)
- "Network TPS calculation - Valid Results"

**After the fix**, you should see:
- "Network TPS calculation - Time boundaries"
- "Network TPS calculation - Valid Results"
- "Network TPS calculation"

The "All TPS records in last 24h" log should NOT appear, confirming the redundant query has been removed.

## Stopping the Environment

### Stop the server
Press `Ctrl+C` in the terminal running `npm run dev`

### Stop MongoDB
```bash
docker stop mongodb
docker rm mongodb
```

## Troubleshooting

### MongoDB Connection Issues
If you see MongoDB connection errors, ensure Docker is running and the container is started:
```bash
docker start mongodb
```

### Rate Limiting
The server implements rate limiting for external APIs. If you see "Rate limit reached" messages, this is normal behavior - the server will automatically retry after the specified delay.

### Port Already in Use
If port 5001 is already in use, either stop the other process or change the PORT in your `.env` file.
