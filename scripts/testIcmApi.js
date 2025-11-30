/**
 * Simple test to verify ICM API is working
 */

require('dotenv').config();
const axios = require('axios');

async function testApi() {
  try {
    console.log('Testing ICM API...');
    console.log('API Base:', process.env.GLACIER_API_BASE);
    console.log('Has API Key:', !!process.env.GLACIER_API_KEY);

    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'l1beat-backend'
    };

    if (process.env.GLACIER_API_KEY) {
      headers['x-glacier-api-key'] = process.env.GLACIER_API_KEY;
    }

    console.log('\nMaking request...');
    const start = Date.now();

    const response = await axios.get(`${process.env.GLACIER_API_BASE}/icm/messages`, {
      headers,
      params: {
        network: 'mainnet',
        pageSize: 100
      },
      timeout: 30000
    });

    const elapsed = Date.now() - start;
    console.log(`✅ Success! Took ${elapsed}ms`);
    console.log('Messages received:', response.data.messages?.length || 0);
    console.log('Has nextPageToken:', !!response.data.nextPageToken);

    if (response.data.messages && response.data.messages.length > 0) {
      const firstMsg = response.data.messages[0];
      const timestamp = firstMsg.sourceTransaction?.timestamp || firstMsg.timestamp;
      if (timestamp) {
        const date = new Date(timestamp * 1000);
        console.log('First message date:', date.toISOString());
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
  }
}

testApi();
