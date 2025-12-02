const mongoose = require('mongoose');
const Chain = require('../src/models/chain');
require('dotenv').config();

async function deleteDuplicateChain() {
  try {
    // Connect to production database
    const dbUri = process.env.NODE_ENV === 'production'
      ? process.env.PROD_MONGODB_URI
      : process.env.DEV_MONGODB_URI;

    await mongoose.connect(dbUri);
    console.log('Connected to database\n');

    // First, let's see all chains with "C-Chain" in the name
    const cChains = await Chain.find({
      $or: [
        { name: /C-Chain/i },
        { chainName: /C-Chain/i }
      ]
    }).lean();

    console.log('Found chains with "C-Chain" in name:');
    cChains.forEach(chain => {
      console.log(`\nID: ${chain._id}`);
      console.log(`Name: ${chain.name || chain.chainName}`);
      console.log(`Chain ID: ${chain.chainId}`);
      console.log(`EVM Chain ID: ${chain.evmChainId}`);
    });

    console.log('\n=================\n');

    // Ask for confirmation
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });

    readline.question('Enter the name of the chain to delete (e.g., "C-Chain"): ', async (chainName) => {
      if (!chainName) {
        console.log('No chain name provided. Exiting.');
        readline.close();
        await mongoose.connection.close();
        return;
      }

      // Find exact match
      const chainToDelete = await Chain.findOne({
        $or: [
          { name: chainName },
          { chainName: chainName }
        ]
      });

      if (!chainToDelete) {
        console.log(`Chain "${chainName}" not found.`);
        readline.close();
        await mongoose.connection.close();
        return;
      }

      console.log('\nChain to delete:');
      console.log(JSON.stringify(chainToDelete, null, 2));

      readline.question('\nAre you sure you want to delete this chain? (yes/no): ', async (answer) => {
        if (answer.toLowerCase() === 'yes') {
          await Chain.deleteOne({ _id: chainToDelete._id });
          console.log(`\n✅ Successfully deleted chain: ${chainName}`);
        } else {
          console.log('\n❌ Deletion cancelled.');
        }

        readline.close();
        await mongoose.connection.close();
        console.log('\nDatabase connection closed.');
      });
    });

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

deleteDuplicateChain();
