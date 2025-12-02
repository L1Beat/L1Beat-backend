const mongoose = require('mongoose');
const BlogPost = require('../src/models/blogPost');
const substackService = require('../src/services/substackService');
const getDbUri = require('./helpers/getDbUri');
require('dotenv').config();

async function debugDuplicate() {
  try {
    // Connect to database
    const dbUri = getDbUri();
    await mongoose.connect(dbUri);
    console.log('✅ Connected to database\n');

    const problemSlug = 'unlocking-a-faster-avalanche-a-deep-dive-into-the-streaming-asynchronous-execution';

    // 1. Check current database state
    console.log('=== DATABASE CHECK ===');
    const existingPosts = await BlogPost.find({ slug: problemSlug });
    console.log(`Found ${existingPosts.length} posts with slug: ${problemSlug}\n`);

    if (existingPosts.length > 0) {
      existingPosts.forEach((post, index) => {
        console.log(`Post ${index + 1}:`);
        console.log(`  _id: ${post._id}`);
        console.log(`  substackId: ${post.substackId}`);
        console.log(`  title: ${post.title}`);
        console.log(`  slug: ${post.slug}`);
        console.log(`  publishedAt: ${post.publishedAt}`);
        console.log('');
      });
    }

    // 2. Check what's in the RSS feed
    console.log('=== RSS FEED CHECK ===');
    const rssData = await substackService.fetchRSSFeed('debug-check');
    const processedPosts = substackService.processRSSItems(rssData.items, 'debug-check');

    const matchingRSSPosts = processedPosts.filter(post =>
      post.slug === problemSlug
    );

    console.log(`Found ${matchingRSSPosts.length} posts in RSS with this slug\n`);

    if (matchingRSSPosts.length > 0) {
      matchingRSSPosts.forEach((post, index) => {
        console.log(`RSS Post ${index + 1}:`);
        console.log(`  substackId: ${post.substackId}`);
        console.log(`  title: ${post.title}`);
        console.log(`  slug: ${post.slug}`);
        console.log(`  publishedAt: ${post.publishedAt}`);
        console.log('');
      });
    }

    // 3. Check for substackId matches
    if (matchingRSSPosts.length > 0 && existingPosts.length > 0) {
      console.log('=== MATCH ANALYSIS ===');
      const rssSubstackIds = matchingRSSPosts.map(p => p.substackId);
      const dbSubstackIds = existingPosts.map(p => p.substackId);

      console.log('RSS substackIds:', rssSubstackIds);
      console.log('DB substackIds:', dbSubstackIds);

      const idsMatch = rssSubstackIds.some(id => dbSubstackIds.includes(id));
      console.log(`\nSubstackIds match: ${idsMatch ? '✅ YES' : '❌ NO'}`);

      if (!idsMatch) {
        console.log('\n⚠️  PROBLEM: SubstackId changed! The article in RSS has a different substackId than the one in DB.');
        console.log('This will cause a duplicate key error on slug.');
        console.log('\nSolution: Delete the old post and let the sync create the new one with the correct substackId.');
      }
    }

    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

debugDuplicate();
