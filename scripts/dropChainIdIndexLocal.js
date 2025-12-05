/**
 * Drop chainId Index from Local Database
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  try {
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);
    console.log('Connected to database\n');

    const db = mongoose.connection.db;
    const chainsCollection = db.collection('chains');

    // List existing indexes
    const indexes = await chainsCollection.indexes();
    console.log('Current indexes:');
    indexes.forEach(idx => {
      console.log(`  - ${idx.name}`);
    });

    // Drop chainId_1 index if it exists
    try {
      await chainsCollection.dropIndex('chainId_1');
      console.log('\n✅ Dropped chainId_1 index');
    } catch (error) {
      if (error.code === 27 || error.codeName === 'IndexNotFound') {
        console.log('\n⚠️  chainId_1 index does not exist (already dropped)');
      } else {
        throw error;
      }
    }

    // List indexes after drop
    const indexesAfter = await chainsCollection.indexes();
    console.log('\nIndexes after drop:');
    indexesAfter.forEach(idx => {
      console.log(`  - ${idx.name}`);
    });

    await mongoose.disconnect();
    console.log('\nDone!');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
