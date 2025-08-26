// Create this as src/scripts/debugRss.js
const axios = require('axios');
const xml2js = require('xml2js');

async function debugRSS() {
    try {
        console.log('Fetching RSS feed...');
        const response = await axios.get('https://ayashbera.substack.com/feed');

        console.log('Parsing RSS...');
        const parser = new xml2js.Parser({
            explicitArray: false,
            ignoreAttrs: false
        });

        const parsedData = await parser.parseStringPromise(response.data);
        const items = parsedData.rss.channel.item;

        console.log('\n=== RSS FEED DEBUG ===');
        console.log('Total items:', Array.isArray(items) ? items.length : 1);

        if (items) {
            const firstItem = Array.isArray(items) ? items[0] : items;
            console.log('\n=== FIRST ITEM STRUCTURE ===');
            console.log('Keys:', Object.keys(firstItem));
            console.log('\n=== GUID ANALYSIS ===');
            console.log('guid type:', typeof firstItem.guid);
            console.log('guid value:', firstItem.guid);
            console.log('\n=== LINK ANALYSIS ===');
            console.log('link type:', typeof firstItem.link);
            console.log('link value:', firstItem.link);
            console.log('\n=== TITLE ===');
            console.log('title:', firstItem.title);
            console.log('\n=== PUB DATE ===');
            console.log('pubDate:', firstItem.pubDate);
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

debugRSS();