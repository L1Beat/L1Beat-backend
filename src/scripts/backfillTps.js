// One-off: re-derive the stored TPS history from every stored txCount bucket.
// Run after changing how TPS is derived (e.g. dropping the 2-decimal rounding
// that stored quiet chains as 0). The daily cron only re-derives 30 days.
//
//   NODE_ENV=production node src/scripts/backfillTps.js
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const TxCount = require("../models/txCount");
const tpsService = require("../services/tpsService");
const logger = require("../utils/logger");

async function backfillTps() {
  await connectDB();

  const chainIds = await TxCount.distinct("chainId");
  let records = 0;
  let failed = 0;

  for (const chainId of chainIds) {
    const result = await tpsService.updateTpsData(chainId, { days: null });
    if (result.success) {
      records += result.recordsProcessed;
    } else {
      failed++;
    }
  }

  logger.info(
    `TPS backfill done: ${chainIds.length} chains, ${records} records, ${failed} failed`
  );
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}

backfillTps().catch((error) => {
  logger.error("TPS backfill failed:", error);
  process.exit(1);
});
