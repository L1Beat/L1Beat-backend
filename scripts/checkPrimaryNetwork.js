require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');

async function main() {
  const dbUri = process.env.NODE_ENV === 'production'
    ? process.env.PROD_MONGODB_URI
    : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

  await mongoose.connect(dbUri);

  // Check for any chain with the primary network subnetId
  const primarySubnetId = '11111111111111111111111111111111LpoYY';
  const primaryChain = await Chain.findOne({ subnetId: primarySubnetId }).lean();

  if (primaryChain) {
    console.log('\n✅ Found a chain with primary network subnetId:\n');
    console.log('Name:', primaryChain.chainName);
    console.log('SubnetId:', primaryChain.subnetId);
    console.log('BlockchainId:', primaryChain.blockchainId);
    console.log('EvmChainId:', primaryChain.evmChainId);
    console.log('VM Name:', primaryChain.vmName);
    console.log('Source:', primaryChain.registryMetadata?.source || 'N/A');
    console.log('\nThis is likely the LAST chain in your registry array.');
    console.log('C-Chain should be evmChainId: 43114, vmName: EVM');
  } else {
    console.log('\n❌ No chain found with primary network subnetId');
  }

  await mongoose.disconnect();
}

main().catch(console.error);
