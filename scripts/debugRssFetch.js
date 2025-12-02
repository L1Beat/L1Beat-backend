const axios = require('axios');
const xml2js = require('xml2js');
require('dotenv').config();

async function debugRssFetch() {
  try {
    console.log('Fetching RSS feed with cache-busting...\n');

    const rssUrl = process.env.SUBSTACK_RSS_URL || 'https://l1beat.substack.com/feed';

    // Try different cache-busting strategies
    const strategies = [
      {
        name: 'With Cache-Control: no-cache',
        headers: {
          'Accept': 'application/rss+xml, application/xml, text/xml',
          'User-Agent': 'l1beat-blog-service',
          'Cache-Control': 'no-cache'
        }
      },
      {
        name: 'With Pragma: no-cache',
        headers: {
          'Accept': 'application/rss+xml, application/xml, text/xml',
          'User-Agent': 'l1beat-blog-service',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      },
      {
        name: 'With timestamp query param',
        url: `${rssUrl}?t=${Date.now()}`,
        headers: {
          'Accept': 'application/rss+xml, application/xml, text/xml',
          'User-Agent': 'l1beat-blog-service'
        }
      }
    ];

    for (const strategy of strategies) {
      console.log(`\n=== ${strategy.name} ===`);

      const response = await axios.get(strategy.url || rssUrl, {
        timeout: 30000,
        headers: strategy.headers
      });

      console.log(`Response size: ${response.data.length} bytes`);
      console.log(`Content-Type: ${response.headers['content-type']}`);

      // Parse XML
      const parser = new xml2js.Parser({
        explicitArray: false,
        ignoreAttrs: false,
      });

      const parsedData = await parser.parseStringPromise(response.data);
      const channel = parsedData.rss.channel;
      const items = Array.isArray(channel.item) ? channel.item : [channel.item];

      console.log(`Parsed items: ${items.length}`);
      console.log(`Last build date: ${channel.lastBuildDate}`);

      console.log('\nArticle titles:');
      items.forEach((item, index) => {
        console.log(`  ${index + 1}. ${item.title}`);
        console.log(`     Published: ${item.pubDate}`);
      });
    }

  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Headers:', error.response.headers);
    }
  }
}

debugRssFetch();
