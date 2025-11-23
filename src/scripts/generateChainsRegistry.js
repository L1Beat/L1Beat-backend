const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SNOWPEER_BASE_URL = 'https://api.snowpeer.io/v1';
const DEFAULT_NETWORK = 'mainnet';
const OUTPUT_DIR = path.join(__dirname, '../../../chains-registry');
const ITEMS_PER_PAGE = 100;

/**
 * Retry helper with exponential backoff
 */
async function retryRequest(requestFn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      const isRateLimited = error.response?.status === 429 ||
                           error.message?.includes('Too many requests');

      if (isRateLimited && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`Rate limited, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }
}

/**
 * Convert string to folder-safe name (lowercase, hyphenated)
 */
function toFolderName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-')         // Spaces to hyphens
    .replace(/-+/g, '-')          // Multiple hyphens to single
    .replace(/^-|-$/g, '');       // Trim hyphens
}

/**
 * Transform SnowPeer socials/links to array format
 */
function transformSocials(links) {
  if (!links || typeof links !== 'object') return [];

  // Check if socials are already in array format (links.socials)
  if (Array.isArray(links.socials) && links.socials.length > 0) {
    const socialMap = {
      x: 'twitter',
      twitter: 'twitter',
      telegram: 'telegram',
      discord: 'discord',
      github: 'github',
      medium: 'medium',
      linkedin: 'linkedin',
      youtube: 'youtube'
    };

    return links.socials.map(social => {
      const lowerName = (social.name || '').toLowerCase();
      const mappedName = socialMap[lowerName] || lowerName;

      return {
        name: mappedName,
        url: social.url
      };
    }).filter(social => social.url); // Filter out any without URLs
  }

  // Fallback: check for direct properties (old format)
  const socials = [];
  const socialMap = {
    x: 'twitter',
    twitter: 'twitter',
    telegram: 'telegram',
    discord: 'discord',
    github: 'github',
    medium: 'medium',
    linkedin: 'linkedin',
    youtube: 'youtube'
  };

  for (const [key, value] of Object.entries(links)) {
    const lowerKey = key.toLowerCase();
    if (socialMap[lowerKey] && value && typeof value === 'string') {
      socials.push({
        name: socialMap[lowerKey],
        url: value
      });
    }
  }

  return socials;
}

/**
 * Transform chain data from SnowPeer format
 */
function transformChain(chain, parentL1Name = '') {
  // Handle both rpcUrl (singular) and rpcUrls (array)
  let rpcUrls = [];
  if (Array.isArray(chain.rpcUrls) && chain.rpcUrls.length > 0) {
    rpcUrls = chain.rpcUrls;
  } else if (chain.rpcUrl && typeof chain.rpcUrl === 'string') {
    rpcUrls = [chain.rpcUrl];
  }

  // Use chain name if available, otherwise use parent L1 name as fallback
  const chainName = chain.name || parentL1Name || 'Unnamed Chain';

  return {
    blockchainId: chain.id || chain.blockchainId,
    name: chainName,
    description: chain.description || '',
    evmChainId: chain.evmId || chain.evmChainId || null,
    vmName: chain.vmName || 'EVM',
    vmId: chain.vmId || '',
    rpcUrls: rpcUrls,
    assets: Array.isArray(chain.assets) ? chain.assets : []
  };
}

/**
 * Transform L1 data from SnowPeer format to our format
 */
function transformL1Data(l1) {
  const website = l1.links?.website || '';
  const socials = transformSocials(l1.links);

  // Transform chains array if it exists, passing parent L1 name as fallback
  const chains = Array.isArray(l1.chains)
    ? l1.chains.map(chain => transformChain(chain, l1.name))
    : [];

  return {
    subnetId: l1.id,
    network: l1.network || DEFAULT_NETWORK,
    categories: Array.isArray(l1.categories) ? l1.categories : [],
    name: l1.name,
    description: l1.description || '',
    logo: l1.logo || l1.icon || '',
    website,
    socials,
    chains
  };
}

/**
 * Generate README.md content for an L1
 */
function generateReadme(l1Data) {
  const timestamp = new Date().toISOString().split('T')[0];

  let content = `# ${l1Data.name}\n\n`;

  // Overview
  content += `## Overview\n\n`;
  content += `${l1Data.description || 'No description available.'}\n\n`;

  // Network Information
  content += `## Network Information\n\n`;
  content += `- **Subnet ID**: \`${l1Data.subnetId}\`\n`;
  content += `- **Network**: ${l1Data.network}\n`;
  if (l1Data.categories.length > 0) {
    content += `- **Categories**: ${l1Data.categories.join(', ')}\n`;
  }
  content += `\n`;

  // Chains
  if (l1Data.chains.length > 0) {
    content += `## Chains\n\n`;

    l1Data.chains.forEach(chain => {
      content += `### ${chain.name}\n\n`;
      content += `- **Blockchain ID**: \`${chain.blockchainId}\`\n`;
      if (chain.evmChainId) {
        content += `- **EVM Chain ID**: \`${chain.evmChainId}\`\n`;
      }
      content += `- **VM**: ${chain.vmName}\n`;
      content += `- **VM ID**: \`${chain.vmId}\`\n\n`;

      // RPC Endpoints
      if (chain.rpcUrls.length > 0) {
        content += `#### RPC Endpoints\n\n`;
        chain.rpcUrls.forEach(rpc => {
          content += `- \`${rpc}\`\n`;
        });
        content += `\n`;
      }

      // Native Assets
      if (chain.assets.length > 0) {
        content += `#### Native Assets\n\n`;
        content += `| Symbol | Name | Decimals |\n`;
        content += `|--------|------|----------|\n`;
        chain.assets.forEach(asset => {
          content += `| ${asset.symbol || 'N/A'} | ${asset.name || 'N/A'} | ${asset.decimals || 'N/A'} |\n`;
        });
        content += `\n`;
      }
    });
  }

  // Links
  if (l1Data.website || l1Data.socials.length > 0) {
    content += `## Links\n\n`;
    if (l1Data.website) {
      content += `- **Website**: ${l1Data.website}\n`;
    }
    l1Data.socials.forEach(social => {
      const capitalizedName = social.name.charAt(0).toUpperCase() + social.name.slice(1);
      content += `- **${capitalizedName}**: ${social.url}\n`;
    });
    content += `\n`;
  }

  content += `---\n\n`;
  content += `*Last updated: ${timestamp}*\n`;

  return content;
}

/**
 * Fetch all L1s with pagination
 */
async function fetchAllL1s(network = DEFAULT_NETWORK) {
  let allL1s = [];
  let page = 1;
  let hasMore = true;

  console.log(`Fetching L1s from SnowPeer API (network: ${network})...`);

  while (hasMore) {
    try {
      console.log(`Fetching page ${page}...`);

      const response = await retryRequest(async () => {
        return await axios.get(`${SNOWPEER_BASE_URL}/amdb/l1s`, {
          params: {
            network,
            limit: ITEMS_PER_PAGE,
            page
          },
          timeout: 30000,
        });
      });

      const l1s = response.data.l1s || [];
      const metadata = response.data.metadata || {};

      allL1s = allL1s.concat(l1s);

      console.log(`Page ${page}: Fetched ${l1s.length} L1s (Total: ${allL1s.length})`);

      // Check if there are more pages
      const totalCount = metadata.totalCount || 0;
      const currentCount = allL1s.length;

      hasMore = currentCount < totalCount && l1s.length > 0;

      if (hasMore) {
        page++;
        // Add delay between pages to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

    } catch (error) {
      console.error(`Error fetching page ${page}:`, error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      throw error;
    }
  }

  console.log(`\nTotal L1s fetched: ${allL1s.length}`);
  return allL1s;
}

/**
 * Fetch individual L1 details by ID
 */
async function fetchL1Details(id, network = DEFAULT_NETWORK) {
  try {
    const response = await retryRequest(async () => {
      return await axios.get(`${SNOWPEER_BASE_URL}/amdb/l1s/${id}`, {
        params: { network },
        timeout: 30000,
      });
    });

    return response.data;
  } catch (error) {
    console.error(`Error fetching details for L1 ${id}:`, error.message);
    return null;
  }
}

/**
 * Generate registry for all L1s
 */
async function generateRegistry() {
  try {
    console.log('Starting Chains Registry Generation...\n');
    console.log('='.repeat(60));

    // Fetch all L1s (list with IDs)
    const l1sList = await fetchAllL1s(DEFAULT_NETWORK);

    console.log('\n' + '='.repeat(60));
    console.log('Fetching detailed data for each L1...\n');

    let successCount = 0;
    let errorCount = 0;
    let detailsFetched = 0;

    for (const l1Basic of l1sList) {
      try {
        // Fetch full details for this L1
        console.log(`[${detailsFetched + 1}/${l1sList.length}] Fetching details for ${l1Basic.name}...`);
        const l1Full = await fetchL1Details(l1Basic.id, DEFAULT_NETWORK);

        if (!l1Full) {
          console.error(`✗ Could not fetch details for ${l1Basic.name}`);
          errorCount++;
          continue;
        }

        detailsFetched++;

        // Transform data
        const transformedData = transformL1Data(l1Full);

        // Create folder name
        const folderName = toFolderName(l1Full.name);
        const folderPath = path.join(OUTPUT_DIR, folderName);

        // Create folder
        if (!fs.existsSync(folderPath)) {
          fs.mkdirSync(folderPath, { recursive: true });
        }

        // Write chain.json
        const jsonPath = path.join(folderPath, 'chain.json');
        fs.writeFileSync(jsonPath, JSON.stringify(transformedData, null, 2));

        // Write README.md
        const readmePath = path.join(folderPath, 'README.md');
        const readmeContent = generateReadme(transformedData);
        fs.writeFileSync(readmePath, readmeContent);

        console.log(`✓ Generated: ${folderName}/`);
        successCount++;

        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`✗ Error generating ${l1Basic.name}:`, error.message);
        errorCount++;
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total L1s in list: ${l1sList.length}`);
    console.log(`Details fetched: ${detailsFetched}`);
    console.log(`Successfully generated: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Output directory: ${OUTPUT_DIR}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\nFATAL ERROR:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the script
generateRegistry();
