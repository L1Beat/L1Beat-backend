const BlogPost = require('../models/blogPost');
const substackService = require('../services/substackService');
const logger = require('../utils/logger');

/**
 * Get all blog posts with pagination and filtering
 */
exports.getAllPosts = async (req, res) => {
    try {
        const { limit = 10, offset = 0, tag } = req.query;
        const requestId = `posts-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        logger.info(`[BLOG CONTROLLER] Get all posts request: limit=${limit}, offset=${offset}, tag=${tag}`);

        let query = { syncStatus: 'synced' };
        if (tag) {
            query.tags = { $in: [tag] };
        }

        // Get posts with pagination
        const posts = await BlogPost.find(query)
            .sort({ publishedAt: -1 })
            .limit(parseInt(limit))
            .skip(parseInt(offset))
            .select('-content') // Exclude full content for list view
            .lean();

        // Get total count for pagination
        const totalCount = await BlogPost.countDocuments(query);

        const hasMore = (parseInt(offset) + parseInt(limit)) < totalCount;

        const response = {
            success: true,
            data: posts,
            metadata: {  // This was probably still "pagination"
                total: totalCount,
                limit: limit,
                offset: offset,
                hasMore: offset + limit < totalCount,
                tag: tag || null,
                requestId: requestId
            }
        };

        res.json(response);

    } catch (error) {
        logger.error('[BLOG CONTROLLER] Error in getAllPosts:', {
            message: error.message,
            stack: error.stack
        });

        res.status(500).json({
            success: false,
            error: 'Failed to fetch blog posts',
            message: error.message
        });
    }
};

/**
 * Get related blog posts based on shared tags
 */
exports.getRelatedPosts = async (req, res) => {
    try {
        const { slug } = req.params;
        const { limit = 4 } = req.query;

        logger.info(`[BLOG CONTROLLER] Get related posts for: ${slug}`);

        // First, get the current post to extract its tags
        const currentPost = await BlogPost.findOne({
            slug: slug,
            syncStatus: 'synced'
        }).select('tags title').lean();

        if (!currentPost) {
            logger.warn(`[BLOG CONTROLLER] Post not found for related posts: ${slug}`);
            return res.status(404).json({
                success: false,
                error: 'Post not found',
                message: `No post found with slug: ${slug}`
            });
        }

        if (!currentPost.tags || currentPost.tags.length === 0) {
            logger.info(`[BLOG CONTROLLER] No tags found for post: ${slug}, returning empty related posts`);
            return res.json({
                success: true,
                data: [],
                metadata: {
                    currentPost: currentPost.title,
                    matchedTags: [],
                    retrievedAt: new Date().toISOString()
                }
            });
        }

        // Find related posts using aggregation pipeline for better performance
        const relatedPosts = await BlogPost.aggregate([
            // Match posts that share at least one tag and aren't the current post
            {
                $match: {
                    syncStatus: 'synced',
                    slug: { $ne: slug },
                    tags: { $in: currentPost.tags }
                }
            },
            // Add a field to count matching tags
            {
                $addFields: {
                    matchingTagsCount: {
                        $size: {
                            $setIntersection: ['$tags', currentPost.tags]
                        }
                    },
                    matchingTags: {
                        $setIntersection: ['$tags', currentPost.tags]
                    }
                }
            },
            // Sort by number of matching tags (descending), then by publish date (descending)
            {
                $sort: {
                    matchingTagsCount: -1,
                    publishedAt: -1
                }
            },
            // Limit results
            {
                $limit: parseInt(limit)
            },
            // Project only needed fields
            {
                $project: {
                    title: 1,
                    slug: 1,
                    excerpt: 1,
                    publishedAt: 1,
                    author: 1,
                    tags: 1,
                    imageUrl: 1,
                    readTime: 1,
                    views: 1,
                    matchingTagsCount: 1,
                    matchingTags: 1
                }
            }
        ]);

        const response = {
            success: true,
            data: relatedPosts,
            metadata: {
                currentPost: currentPost.title,
                currentPostTags: currentPost.tags,
                totalFound: relatedPosts.length,
                retrievedAt: new Date().toISOString()
            }
        };

        logger.info(`[BLOG CONTROLLER] Found ${relatedPosts.length} related posts for ${slug}`);
        res.json(response);

    } catch (error) {
        logger.error(`[BLOG CONTROLLER] Error in getRelatedPosts for ${req.params.slug}:`, {
            message: error.message,
            stack: error.stack
        });

        res.status(500).json({
            success: false,
            error: 'Failed to fetch related posts',
            message: error.message
        });
    }
};

/**
 * Get single blog post by slug
 */
exports.getPostBySlug = async (req, res) => {
    try {
        const { slug } = req.params;

        logger.info(`[BLOG CONTROLLER] Get post by slug: ${slug}`);

        const post = await BlogPost.findOne({
            slug: slug,
            syncStatus: 'synced'
        }).lean();

        if (!post) {
            logger.warn(`[BLOG CONTROLLER] Post not found: ${slug}`);
            return res.status(404).json({
                success: false,
                error: 'Post not found',
                message: `No post found with slug: ${slug}`
            });
        }

        // Increment view count
        await BlogPost.findByIdAndUpdate(
            post._id,
            { $inc: { views: 1 } }
        ).catch(err => {
            logger.warn(`[BLOG CONTROLLER] Failed to increment view count for ${slug}:`, err.message);
        });

        const response = {
            success: true,
            data: post,
            metadata: {
                retrievedAt: new Date().toISOString()
            }
        };

        res.json(response);

    } catch (error) {
        logger.error(`[BLOG CONTROLLER] Error in getPostBySlug for ${req.params.slug}:`, {
            message: error.message,
            stack: error.stack
        });

        res.status(500).json({
            success: false,
            error: 'Failed to fetch blog post',
            message: error.message
        });
    }
};

/**
 * Sync blog posts from RSS
 */
exports.syncPosts = async (req, res) => {
    try {
        logger.info('[BLOG CONTROLLER] Manual sync triggered');

        const result = await substackService.syncArticles('manual-sync');

        res.json({
            success: true,
            data: result
        });

    } catch (error) {
        logger.error('[BLOG CONTROLLER] Error in syncPosts:', {
            message: error.message,
            stack: error.stack
        });

        res.status(500).json({
            success: false,
            error: 'Failed to sync blog posts',
            message: error.message
        });
    }
};

/**
 * Get blog health stats
 */
exports.getBlogHealth = async (req, res) => {
    try {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const thisWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const [
            totalPosts,
            publishedPosts,
            draftPosts,
            postsToday,
            postsThisWeek,
            postsThisMonth,
            lastSync
        ] = await Promise.all([
            BlogPost.countDocuments(),
            BlogPost.countDocuments({ syncStatus: 'synced' }),
            BlogPost.countDocuments({ syncStatus: 'pending' }),
            BlogPost.countDocuments({
                syncStatus: 'synced',
                publishedAt: { $gte: today }
            }),
            BlogPost.countDocuments({
                syncStatus: 'synced',
                publishedAt: { $gte: thisWeek }
            }),
            BlogPost.countDocuments({
                syncStatus: 'synced',
                publishedAt: { $gte: thisMonth }
            }),
            BlogPost.findOne().sort({ updatedAt: -1 }).select('updatedAt').lean()
        ]);

        const response = {
            success: true,
            stats: {
                totalPosts,
                publishedPosts,
                draftPosts,
                lastSyncAt: lastSync ? lastSync.updatedAt.toISOString() : null,
                postsToday,
                postsThisWeek,
                postsThisMonth
            },
            lastUpdate: new Date().toISOString()
        };

        res.json(response);

    } catch (error) {
        logger.error('[BLOG CONTROLLER] Error in getBlogHealth:', {
            message: error.message,
            stack: error.stack
        });

        res.status(500).json({
            success: false,
            error: 'Failed to get blog health',
            message: error.message
        });
    }
};

/**
 * Get all blog tags with counts
 */
exports.getTags = async (req, res) => {
    try {
        const tags = await BlogPost.aggregate([
            { $match: { syncStatus: 'synced' } },
            { $unwind: '$tags' },
            {
                $group: {
                    _id: '$tags',
                    count: { $sum: 1 }
                }
            },
            { $sort: { count: -1 } },
            {
                $project: {
                    _id: 0,
                    name: '$_id',
                    count: 1
                }
            }
        ]);

        res.json({
            success: true,
            data: tags
        });

    } catch (error) {
        logger.error('[BLOG CONTROLLER] Error in getTags:', {
            message: error.message,
            stack: error.stack
        });

        res.status(500).json({
            success: false,
            error: 'Failed to get blog tags',
            message: error.message
        });
    }
};