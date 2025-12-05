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
   * Map Substack author names to Author profiles with optional metadata (photo_url, bio, handle)
   * Substack metadata takes priority over database records for blog post display
   * @param {Array<string>} substackAuthors - Author names from Substack RSS
   * @param {Array<Object>} substackMetadata - Optional metadata from Substack API (photo_url, bio, handle, substack_id)
   * @returns {Promise<Array<Object>>} Array of author profiles
   */
  async mapSubstackAuthors(substackAuthors, substackMetadata = null) {
    try {
      if (!substackAuthors || substackAuthors.length === 0) {
        return await this.getDefaultAuthors();
      }

      // Create lookup map from metadata
      const metadataMap = new Map();
      if (substackMetadata && Array.isArray(substackMetadata)) {
        substackMetadata.forEach(author => {
          metadataMap.set(author.name.toLowerCase(), author);
        });
      }

      const authorProfiles = [];

      for (const authorName of substackAuthors) {
        const metadata = metadataMap.get(authorName.toLowerCase());

        // Try to find existing author by name or substackNames (case-insensitive)
        let author = await Author.findOne({
          $or: [
            { name: { $regex: new RegExp(`^${authorName}$`, "i") } },
            { substackNames: { $elemMatch: { $regex: new RegExp(`^${authorName}$`, "i") } } },
          ],
          isActive: true,
        });

        if (!author) {
          // Create a basic author profile if not found, passing Substack metadata
          author = await this.createBasicAuthorProfile(authorName, metadata);
        } else if (metadata) {
          // Update existing author with Substack metadata
          let hasUpdate = false;

          // Update avatar from Substack (Substack data takes priority)
          if (metadata.photo_url && metadata.photo_url !== author.avatar) {
            author.avatar = metadata.photo_url;
            hasUpdate = true;
            logger.debug(`[AUTHOR SERVICE] Updated avatar for ${authorName} from Substack`);
          }

          // Update bio from Substack if Substack has one
          if (metadata.bio && metadata.bio !== author.bio) {
            author.bio = metadata.bio;
            hasUpdate = true;
          }

          // Add Substack handle to socialLinks
          if (metadata.handle && metadata.handle !== author.socialLinks.substack) {
            author.socialLinks.substack = `https://substack.com/@${metadata.handle}`;
            hasUpdate = true;
          }

          if (hasUpdate) {
            await author.save();
            logger.info(`[AUTHOR SERVICE] Updated author ${authorName} with Substack metadata`);
          }
        }

        if (author) {
          // For blog posts: merge Substack data with JSON file social details
          const profileForBlogPost = this.formatAuthorForResponse(author);
          if (metadata) {
            // Override with Substack data for blog post display (content/media)
            if (metadata.photo_url) {
              profileForBlogPost.avatar = metadata.photo_url;
            }
            if (metadata.bio) {
              profileForBlogPost.bio = metadata.bio;
            }
            // Keep social links from database/JSON file (don't override with Substack)
            // profileForBlogPost.socialLinks already has the values from author database record
          }
          authorProfiles.push(profileForBlogPost);
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
   * Merges Substack metadata with JSON config data
   * @param {string} authorName - Author name from Substack
   * @param {Object} substackMetadata - Optional metadata from Substack API (photo_url, bio, handle, substack_id)
   * @returns {Promise<Object|null>} Created author or null
   */
  async createBasicAuthorProfile(authorName, substackMetadata = null) {
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

      // Check if this author exists in the JSON config
      const jsonAuthor = authorsConfig.defaultAuthors.find(
        a => a.name.toLowerCase() === authorName.toLowerCase() ||
             (a.substackNames && a.substackNames.some(n => n.toLowerCase() === authorName.toLowerCase()))
      );

      // Use Substack metadata if available, otherwise generate URL from slug
      let substackUrl = "";
      let avatar = "";
      let bio = "";

      if (substackMetadata) {
        avatar = substackMetadata.photo_url || "";
        bio = substackMetadata.bio || "";
        if (substackMetadata.handle) {
          substackUrl = `https://substack.com/@${substackMetadata.handle}`;
        }
      } else {
        // Generate potential Substack profile URL from slug as fallback
        const substackSlug = slug.replace(/[^a-z0-9-]/g, "");
        substackUrl = substackSlug ? `https://${substackSlug}.substack.com` : "";
      }

      // Use JSON config if available, otherwise use defaults
      const configData = jsonAuthor || authorsConfig.autoCreateDefaults;
      const jsonSocialLinks = jsonAuthor ? jsonAuthor.socialLinks : authorsConfig.autoCreateDefaults.socialLinks;

      const author = new Author({
        name: authorName,
        slug: jsonAuthor?.slug || slug,
        bio: bio || jsonAuthor?.bio || configData.bio,
        avatar: avatar, // Substack photo_url takes priority
        role: jsonAuthor?.role || configData.role,
        substackNames: [authorName],
        socialLinks: {
          ...jsonSocialLinks,
          substack: substackUrl || (jsonAuthor?.socialLinks?.substack || ""),
        },
        isActive: true,
      });

      await author.save();
      logger.info(`Created basic author profile for: ${authorName}`, {
        fromJsonConfig: !!jsonAuthor,
        hasAvatar: !!avatar,
        hasBio: !!bio,
        hasSubstackUrl: !!substackUrl
      });
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
   * Initialize all default authors from config
   * Creates or updates all default authors to ensure they exist with correct data
   * @returns {Promise<Array>} Array of initialized authors
   */
  async initializeDefaultAuthors() {
    try {
      const authors = [];

      for (const authorConfig of authorsConfig.defaultAuthors) {
        const existingAuthor = await Author.findOne({ name: authorConfig.name });

        if (existingAuthor) {
          // Update existing author with config data
          existingAuthor.slug = authorConfig.slug;
          existingAuthor.bio = authorConfig.bio;
          existingAuthor.avatar = authorConfig.avatar;
          existingAuthor.role = authorConfig.role;
          existingAuthor.substackNames = authorConfig.substackNames;
          existingAuthor.socialLinks = authorConfig.socialLinks;
          existingAuthor.isActive = authorConfig.isActive;
          await existingAuthor.save();
          logger.info(`[AUTHOR SERVICE] Updated existing author: ${authorConfig.name}`);
          authors.push(existingAuthor);
        } else {
          // Create new author from config
          const newAuthor = new Author(authorConfig);
          await newAuthor.save();
          logger.info(`[AUTHOR SERVICE] Created new author: ${authorConfig.name}`);
          authors.push(newAuthor);
        }
      }

      logger.info(`[AUTHOR SERVICE] Initialized ${authors.length} default authors`);
      return authors;
    } catch (error) {
      logger.error("Error initializing default authors:", error.message);
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
