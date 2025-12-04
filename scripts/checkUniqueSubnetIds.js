require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');

async function main() {
  const dbUri = process.env.NODE_ENV === 'production'
    ? process.env.PROD_MONGODB_URI
    : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

  await mongoose.connect(dbUri);

  // Group by subnetId
  const chains = await Chain.find({}).select('chainName subnetId blockchainId').lean();

  const bySubnet = {};
  chains.forEach(chain => {
    const subnetId = chain.subnetId || 'NO_SUBNET_ID';
    if (!bySubnet[subnetId]) {
      bySubnet[subnetId] = [];
    }
    bySubnet[subnetId].push(chain);
  });

  console.log(`\nTotal chains: ${chains.length}`);
  console.log(`Unique subnetIds: ${Object.keys(bySubnet).length}\n`);

  // Find duplicates
  const duplicates = Object.entries(bySubnet).filter(([_, chains]) => chains.length > 1);

  if (duplicates.length > 0) {
    console.log(`⚠️  Found ${duplicates.length} subnetIds with multiple chains:\n`);
    duplicates.forEach(([subnetId, chains]) => {
      console.log(`SubnetId: ${subnetId}`);
      chains.forEach(c => console.log(`  - ${c.chainName}`));
      console.log('');
    });
  } else {
    console.log('✅ All chains have unique subnetIds!\n');
  }

  // Check for chains without subnetId
  const noSubnet = chains.filter(c => !c.subnetId);
  if (noSubnet.length > 0) {
    console.log(`⚠️  ${noSubnet.length} chains without subnetId:`);
    noSubnet.forEach(c => console.log(`  - ${c.chainName}`));
  }

  await mongoose.disconnect();
}

main().catch(console.error);
