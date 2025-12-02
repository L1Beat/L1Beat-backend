const mongoose = require('mongoose');
const BlogPost = require('../src/models/blogPost');
const getDbUri = require('./helpers/getDbUri');
require('dotenv').config();

async function deleteOldPost() {
  try {
    const dbUri = getDbUri();
    await mongoose.connect(dbUri);
    console.log('✅ Connected to database\n');

    // Delete the post with the OLD substackId
    const oldSubstackId = 'unlocking-a-faster-avalanche-a-deep';

    const post = await BlogPost.findOne({ substackId: oldSubstackId });

    if (!post) {
      console.log('❌ Post not found with substackId:', oldSubstackId);
      await mongoose.connection.close();
      return;
    }

    console.log('Found post to delete:');
    console.log(`  _id: ${post._id}`);
    console.log(`  substackId: ${post.substackId}`);
    console.log(`  title: ${post.title}`);
    console.log(`  slug: ${post.slug}`);
    console.log('');

    await BlogPost.deleteOne({ substackId: oldSubstackId });
    console.log('✅ Successfully deleted the old post');
    console.log('\nYou can now run the sync again to create the post with the new substackId.');

    await mongoose.connection.close();
    console.log('✅ Database connection closed');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

deleteOldPost();
