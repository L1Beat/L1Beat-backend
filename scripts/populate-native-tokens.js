const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const REGISTRY_PATH = path.join(__dirname, '../../l1-registry/data');

const GLACIER_API_BASE = process.env.GLACIER_API_BASE || 'https://glacier-api.avax.network/v1';
const GLACIER_API_KEY = process.env.GLACIER_API_KEY;

if (!GLACIER_API_KEY) {
  console.error('Error: GLACIER_API_KEY environment variable is required');
  process.exit(1);
}

const stats = {
  total: 0,
  glacierSuccess: 0,
  noData: 0,
  descriptionsAdded: 0,
  rpcUrlsAdded: 0,
  errors: []
};

async function fetchGlacierData() {
  console.log('Fetching chain data from Glacier API...');

  try {
    const response = await axios.get(`${GLACIER_API_BASE}/chains`, {
      timeout: 60000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'l1beat-backend',
        'x-glacier-api-key': GLACIER_API_KEY
      }
    });

    console.log(`Fetched ${response.data.chains.length} chains from Glacier API`);
    return response.data.chains;
  } catch (error) {
    console.error('Error fetching from Glacier API:', error.message);
    throw error;
  }
}

function processChain(folderName, chainData, glacierMap) {
  const subnetId = chainData.subnetId;
  const glacierChain = glacierMap.get(subnetId);

  let updated = false;

  if (!chainData.chains || chainData.chains.length === 0) {
    stats.errors.push({ folder: folderName, error: 'No chains array found' });
    return false;
  }

  chainData.chains.forEach(chain => {
    delete chain.assets;

    if (glacierChain?.networkToken) {
      chain.nativeToken = {
        symbol: glacierChain.networkToken.symbol,
        name: glacierChain.networkToken.name,
        decimals: glacierChain.networkToken.decimals
      };
      updated = true;
    } else {
      chain.nativeToken = {};
    }

    if (!chain.description && glacierChain?.description) {
      chain.description = glacierChain.description;
      stats.descriptionsAdded++;
    }

    if (chain.rpcUrls.length === 0 && glacierChain?.rpcUrl) {
      chain.rpcUrls = [glacierChain.rpcUrl];
      stats.rpcUrlsAdded++;
    }
  });

  return updated;
}

async function main() {
  console.log('Starting population script...\n');

  const glacierChains = await fetchGlacierData();
  const glacierMap = new Map();
  glacierChains.forEach(chain => {
    glacierMap.set(chain.subnetId, chain);
  });

  console.log(`Created lookup map with ${glacierMap.size} Glacier chains\n`);

  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`Registry path not found: ${REGISTRY_PATH}`);
    process.exit(1);
  }

  const folders = fs.readdirSync(REGISTRY_PATH, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .filter(dirent => !dirent.name.startsWith('.') && !dirent.name.startsWith('_'))
    .map(dirent => dirent.name);

  console.log(`Found ${folders.length} chain folders in registry\n`);
  stats.total = folders.length;

  for (let i = 0; i < folders.length; i++) {
    const folderName = folders[i];
    const chainJsonPath = path.join(REGISTRY_PATH, folderName, 'chain.json');

    try {
      if (!fs.existsSync(chainJsonPath)) {
        console.log(`[${i + 1}/${folders.length}] ⚠️  ${folderName}: chain.json not found`);
        stats.errors.push({ folder: folderName, error: 'chain.json not found' });
        continue;
      }

      const rawData = fs.readFileSync(chainJsonPath, 'utf8');
      const chainData = JSON.parse(rawData);

      const hasGlacierData = processChain(folderName, chainData, glacierMap);

      fs.writeFileSync(chainJsonPath, JSON.stringify(chainData, null, 2) + '\n');

      const chainName = chainData.name || folderName;
      const nativeToken = chainData.chains[0]?.nativeToken;
      const hasToken = nativeToken?.symbol ? `${nativeToken.symbol}` : 'NONE';

      if (hasGlacierData) {
        console.log(`[${i + 1}/${folders.length}] ✓ ${chainName}: ${hasToken}`);
        stats.glacierSuccess++;
      } else {
        console.log(`[${i + 1}/${folders.length}] ⚠️  ${chainName}: No Glacier data`);
        stats.noData++;
      }

    } catch (error) {
      console.error(`[${i + 1}/${folders.length}] ✗ ${folderName}: ${error.message}`);
      stats.errors.push({ folder: folderName, error: error.message });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total chains processed: ${stats.total}`);
  console.log(`Glacier data found: ${stats.glacierSuccess}`);
  console.log(`No Glacier data: ${stats.noData}`);
  console.log(`Descriptions added: ${stats.descriptionsAdded}`);
  console.log(`RPC URLs added: ${stats.rpcUrlsAdded}`);
  console.log(`Errors: ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log('\nErrors encountered:');
    stats.errors.forEach(({ folder, error }) => {
      console.log(`  - ${folder}: ${error}`);
    });
  }

  if (stats.noData > 0) {
    console.log('\nChains requiring manual review (no Glacier data):');
    const folders = fs.readdirSync(REGISTRY_PATH, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .filter(dirent => !dirent.name.startsWith('.') && !dirent.name.startsWith('_'))
      .map(dirent => dirent.name);

    for (const folder of folders) {
      const chainJsonPath = path.join(REGISTRY_PATH, folder, 'chain.json');
      try {
        const data = JSON.parse(fs.readFileSync(chainJsonPath, 'utf8'));
        const nativeToken = data.chains[0]?.nativeToken;
        if (!nativeToken?.symbol) {
          console.log(`  - ${folder} (${data.name})`);
        }
      } catch (e) {
        // Skip
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Migration complete!');
  console.log('='.repeat(60));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
