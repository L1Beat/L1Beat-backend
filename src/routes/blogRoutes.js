const express = require('express');
const router = express.Router();
const blogController = require('../controllers/blogController');
const { validate, validators } = require('../utils/validationMiddleware');
const { param, query } = require("express-validator");

/**
 * @route   GET /api/blog/posts
 * @desc    Get all blog posts with pagination and optional tag filtering
 * @access  Public
 * @query   limit - Number of posts to return (default: 10, max: 100)
 * @query   offset - Number of posts to skip (default: 0)
 * @query   tag - Filter posts by tag (optional)
 */
router.get('/blog/posts',
    validate(validators.getBlogPosts),
    blogController.getAllPosts
);

/**
 * @route   GET /api/blog/posts/:slug/related
 * @desc    Get related blog posts based on shared tags
 * @access  Public
 * @param   slug - Post slug identifier
 * @query   limit - Number of related posts to return (default: 4, max: 6)
 */
router.get('/blog/posts/:slug/related',
    validate([
        param('slug')
            .isString()
            .isLength({ min: 1, max: 200 })
            .matches(/^[a-zA-Z0-9-_]+$/)
            .withMessage('Invalid slug format'),
        query('limit')
            .optional()
            .isInt({ min: 1, max: 6 })
            .withMessage('Limit must be between 1 and 6')
    ]),
    blogController.getRelatedPosts
);


/**
 * @route   GET /api/blog/posts/:slug
 * @desc    Get single blog post by slug
 * @access  Public
 * @param   slug - Post slug identifier
 */
router.get('/blog/posts/:slug',
    validate(validators.getBlogPostBySlug),
    blogController.getPostBySlug
);

/**
 * @route   POST /api/blog/sync
 * @desc    Manually trigger RSS sync with Substack
 * @access  Public (you might want to add auth later)
 */
router.post('/blog/sync',
    validate(validators.syncBlogPosts),
    blogController.syncPosts
);

/**
 * @route   GET /api/blog/health
 * @desc    Get blog service health status and statistics
 * @access  Public
 */
router.get('/blog/health',
    blogController.getBlogHealth
);

/**
 * @route   GET /api/blog/tags
 * @desc    Get all available tags with post counts
 * @access  Public
 */
router.get('/blog/tags',
    blogController.getTags
);

module.exports = router;