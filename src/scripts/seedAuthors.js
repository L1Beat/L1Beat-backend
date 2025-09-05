const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const Author = require("../models/author");
const logger = require("../utils/logger");
require("dotenv").config();

// Load author configuration from JSON file
const authorsConfigPath = path.join(__dirname, "../../config/authors.json");
const authorsConfig = JSON.parse(fs.readFileSync(authorsConfigPath, "utf8"));
const { defaultAuthors } = authorsConfig;

async function seedAuthors() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.NODE_ENV === 'production' 
      ? process.env.PROD_MONGODB_URI 
      : process.env.DEV_MONGODB_URI;
    
    if (!mongoUri) {
      throw new Error("MongoDB URI not found in environment variables");
    }
    
    await mongoose.connect(mongoUri);
    logger.info("Connected to MongoDB for author seeding");
    
    // Clear existing authors (optional - comment out if you want to keep existing)
    // await Author.deleteMany({});
    // logger.info("Cleared existing authors");
    
    // Insert default authors
    let createdCount = 0;
    let updatedCount = 0;
    
    for (const authorData of defaultAuthors) {
      try {
        // Check if author already exists
        const existingAuthor = await Author.findOne({ slug: authorData.slug });
        
        if (existingAuthor) {
          // Update existing author
          await Author.findByIdAndUpdate(existingAuthor._id, authorData);
          updatedCount++;
          logger.info(`Updated author: ${authorData.name}`);
        } else {
          // Create new author
          const author = new Author(authorData);
          await author.save();
          createdCount++;
          logger.info(`Created author: ${authorData.name}`);
        }
      } catch (error) {
        logger.error(`Error processing author ${authorData.name}:`, error.message);
      }
    }
    
    logger.info(`Author seeding completed: ${createdCount} created, ${updatedCount} updated`);
    
    // Verify seeded authors
    const allAuthors = await Author.find({ isActive: true }).sort({ name: 1 });
    logger.info(`Total active authors in database: ${allAuthors.length}`);
    allAuthors.forEach(author => {
      logger.info(`- ${author.name} (${author.slug}) - ${author.role || 'No role'}`);
    });
    
  } catch (error) {
    logger.error("Error seeding authors:", error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    logger.info("MongoDB connection closed");
  }
}

// Run the seeding
if (require.main === module) {
  seedAuthors()
    .then(() => {
      logger.info("Author seeding script completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      logger.error("Author seeding script failed:", error);
      process.exit(1);
    });
}

module.exports = { seedAuthors, authorsConfig };