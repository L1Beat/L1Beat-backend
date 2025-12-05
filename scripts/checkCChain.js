require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');

async function main() {
  const dbUri = process.env.NODE_ENV === 'production'
    ? process.env.PROD_MONGODB_URI
    : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

  await mongoose.connect(dbUri);

  // Check for C-Chain
  const cChain = await Chain.findOne({ chainName: /c-chain/i }).lean();

  if (cChain) {
    console.log('\n✅ C-Chain EXISTS in database\n');
    console.log('Name:', cChain.chainName);
    console.log('SubnetId:', cChain.subnetId);
    console.log('BlockchainId:', cChain.blockchainId);
    console.log('EvmChainId:', cChain.evmChainId);
    console.log('Source:', cChain.registryMetadata?.source || 'N/A');
    console.log('Validators:', cChain.validators?.length || 0);
  } else {
    console.log('\n❌ C-Chain NOT FOUND in database\n');
  }

  await mongoose.disconnect();
}

main().catch(console.error);
