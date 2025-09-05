const Author = require("../models/author");
const logger = require("../utils/logger");
const path = require("path");
const fs = require("fs");

// Load author configuration
const authorsConfigPath = path.join(__dirname, "../../config/authors.json");
const authorsConfig = JSON.parse(fs.readFileSync(authorsConfigPath, "utf8"));

class AuthorService {
  constructor() {
    logger.info("AuthorService initialized");
  }

  /**
   * Map Substack author names to Author profiles
   * @param {Array<string>} substackAuthors - Author names from Substack RSS
   * @returns {Promise<Array<Object>>} Array of author profiles
   */
  async mapSubstackAuthors(substackAuthors) {
    try {
      if (!substackAuthors || substackAuthors.length === 0) {
        return await this.getDefaultAuthors();
      }

      const authorProfiles = [];

      for (const authorName of substackAuthors) {
        // Try to find existing author by name or substackNames
        let author = await Author.findOne({
          $or: [
            { name: { $regex: new RegExp(`^${authorName}$`, "i") } },
            { substackNames: { $in: [authorName] } },
          ],
          isActive: true,
        });

        if (!author) {
          // Create a basic author profile if not found
          author = await this.createBasicAuthorProfile(authorName);
        }

        if (author) {
          authorProfiles.push(this.formatAuthorForResponse(author));
        }
      }

      return authorProfiles.length > 0
        ? authorProfiles
        : await this.getDefaultAuthors();
    } catch (error) {
      logger.error("Error mapping Substack authors:", error.message);
      return await this.getDefaultAuthors();
    }
  }

  /**
   * Create a basic author profile for unknown authors
   * @param {string} authorName - Author name from Substack
   * @returns {Promise<Object|null>} Created author or null
   */
  async createBasicAuthorProfile(authorName) {
    try {
      const slug = authorName
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .trim("-");

      // Check if slug already exists
      const existingAuthor = await Author.findOne({ slug });
      if (existingAuthor) {
        return existingAuthor;
      }

      // Generate potential Substack profile URL
      const substackSlug = slug.replace(/[^a-z0-9-]/g, "");
      const substackUrl = substackSlug
        ? `https://${substackSlug}.substack.com`
        : "";

      // Use defaults from JSON configuration
      const defaults = authorsConfig.autoCreateDefaults;
      
      const author = new Author({
        name: authorName,
        slug: slug,
        bio: defaults.bio,
        avatar: "", // Will use default avatar in frontend
        role: defaults.role,
        substackNames: [authorName],
        socialLinks: {
          ...defaults.socialLinks,
          substack: substackUrl,
        },
        isActive: true,
      });

      await author.save();
      logger.info(`Created basic author profile for: ${authorName}`);
      return author;
    } catch (error) {
      logger.error(
        `Error creating basic author profile for ${authorName}:`,
        error.message
      );
      return null;
    }
  }

  /**
   * Get default authors for fallback
   * @returns {Promise<Array<Object>>} Array of default author profiles
   */
  async getDefaultAuthors() {
    try {
      let defaultAuthor = await Author.findOne({ name: "L1Beat" });

      if (!defaultAuthor) {
        defaultAuthor = await this.createDefaultL1BeatProfile();
      }

      return [this.formatAuthorForResponse(defaultAuthor)];
    } catch (error) {
      logger.error("Error getting default authors:", error.message);
      // Return fallback from JSON config
      return [authorsConfig.fallbackAuthor];
    }
  }

  /**
   * Create default L1Beat profile
   * @returns {Promise<Object>} Created default author
   */
  async createDefaultL1BeatProfile() {
    try {
      // Find the L1Beat config from JSON
      const l1beatConfig = authorsConfig.defaultAuthors.find(
        author => author.name === "L1Beat"
      );
      
      if (!l1beatConfig) {
        throw new Error("L1Beat author configuration not found in authors.json");
      }

      const defaultAuthor = new Author(l1beatConfig);
      await defaultAuthor.save();
      logger.info("Created default L1Beat author profile");
      return defaultAuthor;
    } catch (error) {
      logger.error("Error creating default L1Beat profile:", error.message);
      throw error;
    }
  }

  /**
   * Format author for API response
   * @param {Object} author - Author document
   * @returns {Object} Formatted author object
   */
  formatAuthorForResponse(author) {
    return {
      name: author.name,
      slug: author.slug,
      bio: author.bio,
      avatar: author.avatar,
      role: author.role,
      socialLinks: author.socialLinks,
      postCount: author.postCount,
      joinDate: author.joinDate,
      isActive: author.isActive,
    };
  }

  /**
   * Get author profile by slug
   * @param {string} slug - Author slug
   * @returns {Promise<Object|null>} Author profile or null
   */
  async getAuthorBySlug(slug) {
    try {
      const author = await Author.findOne({ slug, isActive: true });
      return author ? this.formatAuthorForResponse(author) : null;
    } catch (error) {
      logger.error(`Error getting author by slug ${slug}:`, error.message);
      return null;
    }
  }

  /**
   * Get all active authors
   * @returns {Promise<Array<Object>>} Array of author profiles
   */
  async getAllAuthors() {
    try {
      const authors = await Author.find({ isActive: true }).sort({ name: 1 });
      return authors.map((author) => this.formatAuthorForResponse(author));
    } catch (error) {
      logger.error("Error getting all authors:", error.message);
      return [];
    }
  }

  /**
   * Update author post count
   * @param {string} authorName - Author name
   * @returns {Promise<boolean>} Success status
   */
  async updatePostCount(authorName) {
    try {
      const author = await Author.findOne({
        $or: [
          { name: { $regex: new RegExp(`^${authorName}$`, "i") } },
          { substackNames: { $in: [authorName] } },
        ],
      });

      if (author) {
        author.postCount = (author.postCount || 0) + 1;
        await author.save();
        return true;
      }
      return false;
    } catch (error) {
      logger.error(
        `Error updating post count for ${authorName}:`,
        error.message
      );
      return false;
    }
  }
}

module.exports = new AuthorService();
