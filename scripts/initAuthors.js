const mongoose = require('mongoose');
const authorService = require('../src/services/authorService');
const config = require('../src/config/config');
const getDbUri = require('./helpers/getDbUri');
require('dotenv').config();

async function initAuthors() {
  try {
    // Connect to database
    const dbUri = getDbUri();
    await mongoose.connect(dbUri);
    console.log('Connected to database\n');

    // Initialize authors
    console.log('Initializing default authors...\n');
    await authorService.initializeDefaultAuthors();
    console.log('\nAuthors initialized successfully!');

    await mongoose.connection.close();
    console.log('Database connection closed');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

initAuthors();
