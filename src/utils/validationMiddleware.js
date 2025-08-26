const { param, query, validationResult } = require("express-validator");

// Middleware to validate and sanitize request parameters
const validate = (validations) => {
  return async (req, res, next) => {
    // Handle case where validations is undefined, null, or not an array
    if (!validations || !Array.isArray(validations)) {
      console.warn("Warning: validations is not a valid array:", validations);
      return next(); // Skip validation if no valid validations provided
    }

    // Handle empty validation array
    if (validations.length === 0) {
      return next(); // Skip validation if empty array
    }

    try {
      // Execute all validations
      await Promise.all(validations.map((validation) => validation.run(req)));

      // Check for validation errors
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
          message: "Validation failed",
        });
      }

      next();
    } catch (error) {
      console.error("Validation middleware error:", error);
      return res.status(500).json({
        success: false,
        error: "Internal validation error",
        message: "An error occurred during request validation",
      });
    }
  };
};

// Common validation rules
const validationRules = {
  // Chain ID validation
  chainId: param("chainId")
    .trim()
    .notEmpty()
    .withMessage("Chain ID is required")
    .isString()
    .withMessage("Chain ID must be a string"),

  // Days parameter validation (for history endpoints)
  days: query("days")
    .optional()
    .isInt({ min: 1, max: 365 })
    .withMessage("Days must be an integer between 1 and 365")
    .toInt(),
};

// Validation chains for different routes
const validators = {
  // Chain routes
  getChainById: [validationRules.chainId],

  getChainValidators: [validationRules.chainId],

  // TPS routes
  getTpsHistory: [validationRules.chainId, validationRules.days],

  getLatestTps: [validationRules.chainId],

  // Teleporter routes
  getDailyCrossChainMessageCount: [],

  // Weekly teleporter routes
  getWeeklyCrossChainMessageCount: [],

  // Historical daily teleporter routes
  getHistoricalDailyData: [
    query("days")
      .optional()
      .isInt({ min: 1, max: 90 })
      .withMessage("Days must be an integer between 1 and 90")
      .toInt(),
  ],

  // Generic chainId parameter validator
  getChainIdParam: [validationRules.chainId],

  // Blog routes validators
  getBlogPosts: [
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be an integer between 1 and 100")
      .toInt(),
    query("offset")
      .optional()
      .isInt({ min: 0 })
      .withMessage("Offset must be a non-negative integer")
      .toInt(),
    query("tag")
      .optional()
      .isString()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("Tag must be a string between 1 and 50 characters"),
  ],

  getBlogPostBySlug: [
    param("slug")
      .trim()
      .notEmpty()
      .withMessage("Slug is required")
      .isString()
      .withMessage("Slug must be a string")
      .isLength({ min: 1, max: 100 })
      .withMessage("Slug must be between 1 and 100 characters")
      .matches(/^[a-z0-9-]+$/)
      .withMessage(
        "Slug can only contain lowercase letters, numbers, and hyphens"
      ),
  ],

  // Fixed: Add explicit empty validation for sync endpoint
  syncBlogPosts: [],

  // Add health endpoint validation (no validation needed)
  getBlogHealth: [],

  // Add tags endpoint validation (no validation needed)
  getBlogTags: [],
};

module.exports = {
  validate,
  validators,
};
