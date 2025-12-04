require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');

async function main() {
  const dbUri = process.env.NODE_ENV === 'production'
    ? process.env.PROD_MONGODB_URI
    : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

  await mongoose.connect(dbUri);

  // Find Coqnet (case-insensitive)
  const coqnet = await Chain.findOne({
    chainName: /coqnet/i
  }).lean();

  if (coqnet) {
    console.log('\n=== COQNET DETAILS ===\n');
    console.log('Chain Name:', coqnet.chainName);
    console.log('Chain ID:', coqnet.chainId);
    console.log('EVM Chain ID:', coqnet.evmChainId || 'N/A');
    console.log('Blockchain ID:', coqnet.blockchainId || 'N/A');
    console.log('Platform Chain ID:', coqnet.platformChainId || 'N/A');
    console.log('Subnet ID:', coqnet.subnetId || 'N/A');
    console.log('VM Name:', coqnet.vmName || 'N/A');
    console.log('Source:', coqnet.registryMetadata?.source || 'No source');
    console.log('Validators:', coqnet.validators?.length || 0);
    console.log('RPC URL:', coqnet.rpcUrl || coqnet.rpcUrls?.[0] || 'N/A');
    console.log('Explorer URL:', coqnet.explorerUrl || 'N/A');
    console.log('Categories:', coqnet.categories?.join(', ') || 'N/A');
    console.log('Network:', coqnet.network || 'N/A');
    console.log('Last Updated:', coqnet.lastUpdated || 'N/A');
    console.log('\n');
  } else {
    console.log('\nCoqnet not found in database!\n');
  }

  await mongoose.disconnect();
}

main().catch(console.error);
