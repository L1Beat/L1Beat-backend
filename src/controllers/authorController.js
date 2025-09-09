const authorService = require("../services/authorService");
const logger = require("../utils/logger");
const { validationResult } = require("express-validator");

class AuthorController {
  /**
   * Get all authors
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async getAllAuthors(req, res) {
    const requestId = `authors-${Date.now()}`;
    
    try {
      logger.info(`[AUTHOR API] Getting all authors [${requestId}]`);
      
      const authors = await authorService.getAllAuthors();
      
      res.json({
        success: true,
        data: authors,
        metadata: {
          total: authors.length,
          requestId,
          retrievedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error(`[AUTHOR API] Error getting all authors [${requestId}]:`, {
        message: error.message,
        stack: error.stack,
      });
      
      res.status(500).json({
        success: false,
        error: "Failed to fetch authors",
        requestId,
      });
    }
  }

  /**
   * Get author by slug
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async getAuthorBySlug(req, res) {
    const { slug } = req.params;
    const requestId = `author-${slug}-${Date.now()}`;
    
    try {
      logger.info(`[AUTHOR API] Getting author by slug: ${slug} [${requestId}]`);
      
      if (!slug) {
        return res.status(400).json({
          success: false,
          error: "Author slug is required",
          requestId,
        });
      }
      
      const author = await authorService.getAuthorBySlug(slug);
      
      if (!author) {
        return res.status(404).json({
          success: false,
          error: "Author not found",
          requestId,
        });
      }
      
      res.json({
        success: true,
        data: author,
        metadata: {
          requestId,
          retrievedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error(`[AUTHOR API] Error getting author ${slug} [${requestId}]:`, {
        message: error.message,
        stack: error.stack,
      });
      
      res.status(500).json({
        success: false,
        error: "Failed to fetch author",
        requestId,
      });
    }
  }

  /**
   * Get author profiles for blog post authors
   * @param {Object} req - Express request object  
   * @param {Object} res - Express response object
   */
  async getAuthorProfiles(req, res) {
    const requestId = `author-profiles-${Date.now()}`;
    
    try {
      const { authors } = req.body;
      
      if (!authors || !Array.isArray(authors)) {
        return res.status(400).json({
          success: false,
          error: "Authors array is required",
          requestId,
        });
      }
      
      logger.info(`[AUTHOR API] Getting author profiles for: ${authors.join(", ")} [${requestId}]`);
      
      const authorProfiles = await authorService.mapSubstackAuthors(authors);
      
      res.json({
        success: true,
        data: authorProfiles,
        metadata: {
          requestedAuthors: authors,
          foundCount: authorProfiles.length,
          requestId,
          retrievedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error(`[AUTHOR API] Error getting author profiles [${requestId}]:`, {
        message: error.message,
        stack: error.stack,
      });
      
      res.status(500).json({
        success: false,
        error: "Failed to fetch author profiles",
        requestId,
      });
    }
  }
}

module.exports = new AuthorController();