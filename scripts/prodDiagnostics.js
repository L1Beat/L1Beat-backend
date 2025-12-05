/**
 * Production Diagnostics
 *
 * Run this in production to diagnose C-Chain sync issues
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
const fs = require('fs');
const path = require('path');

async function main() {
  try {
    console.log('=== PRODUCTION DIAGNOSTICS ===\n');

    // 1. Check registry folders
    console.log('1. Checking l1-registry folders...');
    const registryPath = path.join(__dirname, '../l1-registry/data');

    if (!fs.existsSync(registryPath)) {
      console.error(`❌ Registry path not found: ${registryPath}`);
      process.exit(1);
    }

    const folders = fs.readdirSync(registryPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .filter(dirent => !dirent.name.startsWith('.') && !dirent.name.startsWith('_'))
      .map(dirent => dirent.name);

    console.log(`   Found ${folders.length} folders\n`);

    // 2. Check for Avalanche folder
    const avalancheFolders = folders.filter(f => f.toLowerCase().includes('avalanche'));
    console.log('2. Avalanche folders:');
    if (avalancheFolders.length === 0) {
      console.error('   ❌ No Avalanche folder found!');
    } else {
      avalancheFolders.forEach(folder => {
        console.log(`   - ${folder}`);
        const chainJsonPath = path.join(registryPath, folder, 'chain.json');
        if (fs.existsSync(chainJsonPath)) {
          const chainData = JSON.parse(fs.readFileSync(chainJsonPath, 'utf8'));
          console.log(`     SubnetId: ${chainData.subnetId}`);
          console.log(`     Chains: ${chainData.chains?.length || 0}`);
          if (chainData.chains) {
            chainData.chains.forEach(c => {
              console.log(`       - ${c.name} (evmChainId: ${c.evmChainId})`);
            });
          }
        }
      });
    }

    // 3. Connect to database
    console.log('\n3. Connecting to database...');
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.LOCAL_MONGODB_URI || process.env.DEV_MONGODB_URI;

    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    await mongoose.connect(dbUri);
    console.log('   ✅ Connected\n');

    // 4. Check for C-Chain
    console.log('4. Checking for C-Chain in database...');
    const cChain = await Chain.findOne({
      $or: [
        { evmChainId: 43114 },
        { chainName: /c-chain/i }
      ]
    });

    if (cChain) {
      console.log('   ✅ C-Chain FOUND:');
      console.log(`      Name: ${cChain.chainName}`);
      console.log(`      SubnetId: ${cChain.subnetId}`);
      console.log(`      BlockchainId: ${cChain.blockchainId}`);
      console.log(`      EvmChainId: ${cChain.evmChainId}`);
      console.log(`      Source: ${cChain.registryMetadata?.source || 'N/A'}`);
      console.log(`      Folder: ${cChain.registryMetadata?.folderName || 'N/A'}`);
    } else {
      console.log('   ❌ C-Chain NOT FOUND\n');
    }

    // 5. Check primary network subnetId
    console.log('\n5. Checking primary network subnetId...');
    const primarySubnetId = '11111111111111111111111111111111LpoYY';
    const primaryChain = await Chain.findOne({ subnetId: primarySubnetId });

    if (primaryChain) {
      console.log(`   Chain: ${primaryChain.chainName}`);
      console.log(`   EvmChainId: ${primaryChain.evmChainId}`);
      console.log(`   Expected: C-Chain with evmChainId 43114`);
      if (primaryChain.evmChainId === 43114) {
        console.log('   ✅ Correct!');
      } else {
        console.log(`   ❌ Wrong chain! This should be C-Chain`);
      }
    } else {
      console.log('   ❌ No chain with primary network subnetId');
    }

    // 6. Total chains
    const total = await Chain.countDocuments();
    console.log(`\n6. Total chains in database: ${total}`);

    // 7. Git info (if available)
    console.log('\n7. Registry git info:');
    const { execSync } = require('child_process');
    try {
      const registryGitPath = path.join(__dirname, '../l1-registry');
      const branch = execSync('git branch --show-current', { cwd: registryGitPath }).toString().trim();
      const commit = execSync('git rev-parse --short HEAD', { cwd: registryGitPath }).toString().trim();
      const lastCommitMsg = execSync('git log -1 --pretty=%B', { cwd: registryGitPath }).toString().trim();
      console.log(`   Branch: ${branch}`);
      console.log(`   Commit: ${commit}`);
      console.log(`   Last commit: ${lastCommitMsg}`);
    } catch (err) {
      console.log('   (git info not available)');
    }

    await mongoose.disconnect();
    console.log('\n=== DIAGNOSTICS COMPLETE ===');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
