const axios = require("axios");
const xml2js = require("xml2js");
const config = require("../config/config");
const logger = require("../utils/logger");
const BlogPost = require("../models/blogPost");
const authorService = require("./authorService");
const cheerio = require("cheerio");

class SubstackService {
  constructor() {
    this.RSS_URL = "https://l1beat.substack.com/feed";
    this.TIMEOUT = 30000; // 30 seconds
    this.UPDATE_INTERVAL = 1 * 60 * 60 * 1000; // 1hour in milliseconds

    logger.info("SubstackService initialized", {
      rssUrl: this.RSS_URL,
      updateInterval: "1 hour",
    });
  }

  /**
   * Extract authors from RSS item
   * @param {Object} item - RSS item
   * @returns {Array<string>} Array of author names
   */
  extractAuthorsFromRSS(item) {
    const authors = [];

    try {
      // Method 1: Check for Dublin Core creator field (most common in Substack)
      if (item["dc:creator"]) {
        const dcCreator = item["dc:creator"];
        if (typeof dcCreator === "string") {
          authors.push(dcCreator.trim());
        } else if (Array.isArray(dcCreator)) {
          authors.push(...dcCreator.map((author) => author.trim()));
        }
      }

      // Method 2: Check for standard author field
      if (item.author && !authors.length) {
        const authorField = item.author;
        if (typeof authorField === "string") {
          // Parse email format like "email@domain.com (Author Name)"
          const emailMatch = authorField.match(/\((.+?)\)$/);
          if (emailMatch) {
            authors.push(emailMatch[1].trim());
          } else if (!authorField.includes("@")) {
            // If it's not an email, use as-is
            authors.push(authorField.trim());
          }
        }
      }

      // Method 3: Check for creator field
      if (item.creator && !authors.length) {
        const creator = item.creator;
        if (typeof creator === "string") {
          authors.push(creator.trim());
        } else if (Array.isArray(creator)) {
          authors.push(...creator.map((author) => author.trim()));
        }
      }

      // Method 4: Parse from content if no explicit author found
      if (!authors.length && item["content:encoded"]) {
        const contentAuthors = this.extractAuthorsFromContent(
          item["content:encoded"]
        );
        if (contentAuthors.length > 0) {
          authors.push(...contentAuthors);
        }
      }

      // Fallback: Use default if no authors found
      if (!authors.length) {
        authors.push("L1Beat");
      }

      // Clean and deduplicate authors
      const cleanedAuthors = [...new Set(authors)]
        .map((author) => author.trim())
        .filter((author) => author.length > 0)
        .map((author) => this.cleanAuthorName(author));

      logger.debug("Extracted authors:", {
        originalItem: {
          "dc:creator": item["dc:creator"],
          author: item.author,
          creator: item.creator,
        },
        extractedAuthors: cleanedAuthors,
      });

      return cleanedAuthors.length > 0 ? cleanedAuthors : ["L1Beat"];
    } catch (error) {
      logger.error("Error extracting authors from RSS item:", error.message);
      return ["L1Beat"];
    }
  }

  /**
   * Extract authors from content (fallback method)
   * @param {string} content - HTML content
   * @returns {Array<string>} Array of author names
   */
  extractAuthorsFromContent(content) {
    const authors = [];

    try {
      const $ = cheerio.load(content);

      // Look for common author patterns in content
      const authorPatterns = [
        /by\s+([A-Za-z\s]+)/i,
        /written\s+by\s+([A-Za-z\s]+)/i,
        /author:\s*([A-Za-z\s]+)/i,
      ];

      const textContent = $.text();

      for (const pattern of authorPatterns) {
        const match = textContent.match(pattern);
        if (match && match[1]) {
          const author = match[1].trim();
          if (author.length > 2 && author.length < 50) {
            authors.push(author);
            break; // Take first match
          }
        }
      }
    } catch (error) {
      logger.warn("Error extracting authors from content:", error.message);
    }

    return authors;
  }

  /**
   * Clean and normalize author name
   * @param {string} author - Raw author name
   * @returns {string} Cleaned author name
   */
  cleanAuthorName(author) {
    if (!author) return "";

    return author
      .trim()
      .replace(/\s+/g, " ") // Normalize whitespace
      .replace(/^(by|author:?)\s*/i, "") // Remove common prefixes
      .replace(/\s*\([^)]*\)$/, "") // Remove parenthetical info at end
      .trim();
  }

  /**
   * Fetch post details from Substack API to get co-author information with profile metadata
   * @param {string} slug - Post slug (from URL)
   * @returns {Promise<Array<Object>>} Array of co-author objects with name, photo_url, bio, handle
   */
  async fetchPostAuthorsFromAPI(slug) {
    try {
      logger.info(`[SUBSTACK API] Fetching co-authors for slug: ${slug}`);

      // Fetch from Substack API using slug to get publishedBylines
      const response = await axios.get(
        `https://l1beat.substack.com/api/v1/posts/${slug}`,
        {
          timeout: 10000,
          headers: {
            Accept: "application/json",
            "User-Agent": "l1beat-blog-service",
          },
        }
      );

      logger.info(`[SUBSTACK API] Response received for slug=${slug}, has publishedBylines: ${!!response.data.publishedBylines}`);

      // Extract author objects with metadata from publishedBylines field
      if (response.data && response.data.publishedBylines && Array.isArray(response.data.publishedBylines)) {
        const authorsWithMetadata = response.data.publishedBylines
          .filter((author) => author.name && author.name.length > 0)
          .map((author) => ({
            name: author.name,
            handle: author.handle || null,
            photo_url: author.photo_url || null,
            bio: author.bio || null,
            substack_id: author.id || null
          }));

        logger.info(
          `[SUBSTACK API] Retrieved ${authorsWithMetadata.length} co-authors with metadata for post slug=${slug}`,
          { authors: authorsWithMetadata.map(a => ({ name: a.name, has_photo: !!a.photo_url })) }
        );

        if (authorsWithMetadata.length > 0) {
          return authorsWithMetadata;
        }
      } else {
        logger.warn(`[SUBSTACK API] No publishedBylines found in response for slug=${slug}`);
      }

      return null;
    } catch (error) {
      logger.error(
        `[SUBSTACK API] Error fetching post details for slug=${slug}`,
        { message: error.message, code: error.code }
      );
      return null;
    }
  }

  /**
   * Extract post ID from Substack URL
   * @param {string} url - Post URL
   * @returns {string|null} Post ID or null
   */
  extractPostIdFromURL(url) {
    try {
      // Substack URLs have format: https://l1beat.substack.com/p/{slug}?{params}
      // Post ID may be in URL params or we need to fetch it
      // For now, return null and rely on RSS data
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Fetch RSS feed from Substack
   * @param {string} requestId - Request ID for tracking
   * @returns {Promise<Object>} Parsed RSS data
   */
  async fetchRSSFeed(requestId = "unknown") {
    try {
      // Add timestamp query param to bypass CDN cache
      const cacheBustingUrl = `${this.RSS_URL}?t=${Date.now()}`;

      logger.info(`[SUBSTACK RSS] Fetching RSS feed [${requestId}]`, {
        url: this.RSS_URL,
      });

      const response = await axios.get(cacheBustingUrl, {
        timeout: this.TIMEOUT,
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml",
          "User-Agent": "l1beat-blog-service",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
      });

      if (!response.data) {
        throw new Error("No data received from RSS feed");
      }

      logger.info(
        `[SUBSTACK RSS] Successfully fetched RSS data [${requestId}]`,
        {
          dataLength: response.data.length,
          contentType: response.headers["content-type"],
        }
      );

      // Parse XML to JSON
      const parser = new xml2js.Parser({
        explicitArray: false,
        ignoreAttrs: false,
      });

      const parsedData = await parser.parseStringPromise(response.data);

      if (!parsedData.rss || !parsedData.rss.channel) {
        throw new Error("Invalid RSS feed structure");
      }

      const channel = parsedData.rss.channel;
      const items = Array.isArray(channel.item) ? channel.item : [channel.item];

      logger.info(`[SUBSTACK RSS] Parsed RSS feed [${requestId}]`, {
        channelTitle: channel.title,
        itemCount: items ? items.length : 0,
      });

      return {
        channel: channel,
        items: items || [],
      };
    } catch (error) {
      logger.error(`[SUBSTACK RSS] Error fetching RSS feed [${requestId}]:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
      });
      throw error;
    }
  }

  processRSSItems(items, requestId = "unknown") {
    try {
      logger.info(
        `[SUBSTACK PROCESS] Processing ${items.length} RSS items [${requestId}]`
      );

      const processedPosts = items
        .map((item, index) => {
          try {
            // Extract basic information
            const title = item.title || "Untitled";
            const link = item.link || item.guid;
            const pubDate = new Date(item.pubDate);

            // Extract slug from URL (e.g., https://l1beat.substack.com/p/slug-here?...)
            let slug = this.extractSlugFromURL(link);
            if (!slug) {
              // Fallback: generate slug from title if extraction fails
              slug = this.generateSlug(title);
            }

            // Extract authors from RSS item
            const authors = this.extractAuthorsFromRSS(item);

            // Extract subtitle from description field
            let subtitle = "";
            let mainContent = "";
            let cleanContent = "";

            // Get subtitle from description field
            const description = item.description || "";
            if (description && description.trim()) {
              subtitle = this.cleanSubtitle(description);
            }

            // Get main content from content:encoded
            const rawContent = item["content:encoded"] || "";
            if (rawContent) {
              cleanContent = this.cleanMainContent(rawContent);
              mainContent = cleanContent;
            } else if (description && !subtitle) {
              // Fallback: if no content:encoded and description doesn't look like subtitle
              cleanContent = this.cleanMainContent(description);
              mainContent = cleanContent;
              subtitle = ""; // No subtitle in this case
            }

            // Generate excerpt from main content only (excluding subtitle)
            const excerpt = this.generateExcerpt(mainContent);

            // Extract Substack ID from GUID or link
            const substackId = this.extractSubstackId(item.guid || link);

            // Extract categories/tags if available
            const tags = this.extractTags(item.category);

            logger.debug(
              `[SUBSTACK PROCESS] Processed item ${
                index + 1
              }: ${title} [${requestId}]`,
              {
                hasSubtitle: !!subtitle,
                subtitleLength: subtitle.length,
                contentLength: mainContent.length,
                authorsCount: authors.length,
                authors: authors,
              }
            );

            return {
              title: title.trim(),
              slug: slug,
              subtitle: subtitle,
              content: cleanContent,
              mainContent: mainContent,
              excerpt: excerpt,
              publishedAt: pubDate,
              authors: authors, // UPDATED: Use extracted authors array
              author: authors[0] || "L1Beat", // Keep for backward compatibility
              substackUrl: link,
              substackId: substackId,
              tags: tags,
              syncStatus: "pending",
            };
          } catch (itemError) {
            logger.error(
              `[SUBSTACK PROCESS] Error processing item ${
                index + 1
              } [${requestId}]:`,
              {
                error: itemError.message,
                item: {
                  title: item.title,
                  guid: item.guid,
                  link: item.link,
                },
              }
            );
            return null;
          }
        })
        .filter((post) => post !== null);

      logger.info(
        `[SUBSTACK PROCESS] Successfully processed ${processedPosts.length} posts [${requestId}]`
      );
      return processedPosts;
    } catch (error) {
      logger.error(
        `[SUBSTACK PROCESS] Error processing RSS items [${requestId}]:`,
        {
          message: error.message,
          stack: error.stack,
        }
      );
      throw error;
    }
  }

  /**
   * Sync articles with database
   * @param {string} requestId - Request ID for tracking
   * @returns {Promise<Object>} Sync result
   */
  async syncArticles(
    requestId = `sync-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 8)}`
  ) {
    try {
      logger.info(`[SUBSTACK SYNC] Starting article sync [${requestId}]`);

      // Fetch RSS feed
      const rssData = await this.fetchRSSFeed(requestId);

      if (!rssData.items || rssData.items.length === 0) {
        logger.warn(
          `[SUBSTACK SYNC] No articles found in RSS feed [${requestId}]`
        );
        return { success: true, synced: 0, updated: 0, errors: 0 };
      }

      // Process RSS items
      const processedPosts = this.processRSSItems(rssData.items, requestId);

      let syncedCount = 0;
      let updatedCount = 0;
      let errorCount = 0;

      // Sync each post
      for (const postData of processedPosts) {
        try {
          // Try to fetch co-author information from Substack API using post slug
          let finalAuthors = postData.authors;
          let authorMetadata = null;
          if (postData.slug) {
            const apiAuthors = await this.fetchPostAuthorsFromAPI(postData.slug);

            if (apiAuthors && apiAuthors.length > 0) {
              // Extract names for finalAuthors, store full metadata
              authorMetadata = apiAuthors;
              finalAuthors = apiAuthors.map(a => a.name);
              logger.info(
                `[SUBSTACK SYNC] Updated authors from API for "${postData.title}": ${finalAuthors.join(", ")}`
              );
            }
          }

          // Calculate reading time
          const readingTime = this.calculateReadingTime(postData.content);

          // Map authors to profiles, passing metadata for avatar extraction
          const authorProfiles = await authorService.mapSubstackAuthors(finalAuthors, authorMetadata);

          // Extract author names from profiles for consistency
          const profileNames = authorProfiles.map(profile => profile.name);

          // Fetch existing post to preserve JSON-only fields
          const existingPost = await BlogPost.findOne({ substackId: postData.substackId });

          // Prepare data for database - Substack data takes priority
          const dbData = {
            // Substack priority fields (always update from Substack)
            title: postData.title,
            slug: postData.slug,
            subtitle: postData.subtitle || "",
            excerpt: postData.excerpt,
            content: postData.content,
            mainContent: postData.mainContent || postData.content,
            publishedAt: postData.publishedAt,
            authors: profileNames.length > 0 ? profileNames : ["L1Beat"],
            author: profileNames.length > 0 ? profileNames[0] : "L1Beat",
            authorProfiles: authorProfiles,
            substackUrl: postData.substackUrl,
            substackId: postData.substackId,
            tags: postData.tags,
            // Metadata fields
            readTime: readingTime,
            lastSynced: new Date(),
            syncStatus: "synced",
            // Preserve existing JSON-only fields if they exist
            imageUrl: existingPost?.imageUrl || postData.imageUrl || "",
            sourceUrl: existingPost?.sourceUrl || postData.sourceUrl || "",
            views: existingPost?.views || 0,
          };

          // Update or create post
          const result = await BlogPost.findOneAndUpdate(
            { substackId: postData.substackId },
            { $set: dbData },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true,
            }
          );

          if (result.isNew || result.lastModified) {
            updatedCount++;
          }
          syncedCount++;

          logger.debug(
            `[SUBSTACK SYNC] Synced post: ${
              postData.title
            } [${requestId}] - Authors: ${finalAuthors.join(", ")}`
          );
        } catch (postError) {
          errorCount++;
          logger.error(`[SUBSTACK SYNC] Error syncing post [${requestId}]:`, {
            title: postData.title,
            error: postError.message,
          });
        }
      }

      // Cleanup deleted articles
      const deletedCount = await this.cleanupDeletedArticles(
        processedPosts,
        requestId
      );

      logger.info(`[SUBSTACK SYNC] Sync completed [${requestId}]`, {
        totalPosts: processedPosts.length,
        syncedCount,
        updatedCount,
        errorCount,
        deletedCount,
      });

      return {
        success: true,
        synced: syncedCount,
        updated: updatedCount,
        errors: errorCount,
        deleted: deletedCount,
      };
    } catch (error) {
      logger.error(
        `[SUBSTACK SYNC] Critical error during sync [${requestId}]:`,
        {
          message: error.message,
          stack: error.stack,
        }
      );
      throw error;
    }
  }

  /**
   * Remove articles from database that no longer exist in the RSS feed
   * @param {Array} currentPosts - Array of posts currently in RSS feed
   * @param {string} requestId - Request ID for tracking
   * @returns {Promise<number>} Number of deleted articles
   */
  async cleanupDeletedArticles(currentPosts, requestId = "unknown") {
    try {
      const currentSubstackIds = currentPosts.map((post) => post.substackId);

      logger.info(
        `[SUBSTACK CLEANUP] Checking for deleted articles [${requestId}]`,
        {
          currentArticleCount: currentSubstackIds.length,
        }
      );

      const result = await BlogPost.deleteMany({
        substackId: { $nin: currentSubstackIds, $exists: true },
      });

      if (result.deletedCount > 0) {
        logger.info(
          `[SUBSTACK CLEANUP] Removed ${result.deletedCount} deleted articles [${requestId}]`
        );
      }

      return result.deletedCount;
    } catch (error) {
      logger.error(
        `[SUBSTACK CLEANUP] Error cleaning up deleted articles [${requestId}]:`,
        {
          message: error.message,
        }
      );
      return 0;
    }
  }

  // Rest of the existing helper methods remain the same
  /**
   * Extract slug from Substack URL
   * @param {string} url - URL like https://l1beat.substack.com/p/slug-here or https://l1beat.substack.com/p/slug-here?param=value
   * @returns {string|null} Slug or null if not found
   */
  extractSlugFromURL(url) {
    try {
      if (!url) return null;

      // Match pattern: /p/slug-here or /p/slug-here?
      const match = url.match(/\/p\/([^/?]+)/);
      if (match && match[1]) {
        return match[1];
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  generateSlug(title) {
    return title
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim("-")
      .substring(0, 100);
  }

  cleanSubtitle(description) {
    if (!description) return "";

    // Remove HTML tags
    let subtitle = description.replace(/<[^>]*>/g, "").trim();

    // Remove common Substack prefixes/suffixes
    subtitle = subtitle.replace(/^(Subtitle:|Summary:)/i, "").trim();

    // Limit length for subtitles (should be concise)
    if (subtitle.length > 200) {
      subtitle = subtitle.substring(0, 200).trim() + "...";
    }

    // Check if this looks like a subtitle vs main content
    const sentences = subtitle
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 0);
    if (sentences.length > 3 || subtitle.length > 150) {
      return "";
    }

    return subtitle;
  }

  cleanMainContent(content) {
    if (!content) return "";

    // Remove CDATA wrappers
    let cleanContent = content.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1");

    // Load into cheerio for DOM manipulation
    const $ = cheerio.load(cleanContent);

    // Remove unwanted elements
    $(
      'script, style, iframe[src*="substack"], .subscription-widget, .captioned-button'
    ).remove();

    // Clean up Substack-specific classes and attributes
    $("*").removeAttr("class").removeAttr("id").removeAttr("style");

    // Process paragraphs
    $("p").each((i, elem) => {
      const $p = $(elem);
      const text = $p.text().trim();

      if (!text) {
        $p.remove();
        return;
      }

      $p.addClass("mb-6 leading-relaxed text-gray-700 dark:text-gray-300");
    });

    // Process headings
    $("h1, h2, h3, h4, h5, h6").each((i, elem) => {
      const $h = $(elem);
      const tagName = elem.tagName.toLowerCase();

      const headingClasses = {
        h1: "text-3xl font-bold mt-12 mb-6 text-gray-900 dark:text-white",
        h2: "text-2xl font-bold mt-10 mb-5 text-gray-900 dark:text-white",
        h3: "text-xl font-semibold mt-8 mb-4 text-gray-900 dark:text-white",
        h4: "text-lg font-semibold mt-6 mb-3 text-gray-900 dark:text-white",
        h5: "text-base font-semibold mt-4 mb-2 text-gray-900 dark:text-white",
        h6: "text-sm font-semibold mt-4 mb-2 text-gray-700 dark:text-gray-300",
      };

      $h.addClass(headingClasses[tagName] || headingClasses.h4);
    });

    // Process images
    $("img").each((i, elem) => {
      const $img = $(elem);
      $img.addClass("w-full h-auto rounded-lg my-8 shadow-lg");
      $img.removeAttr("width").removeAttr("height");

      if (!$img.parent().is("figure")) {
        $img.wrap('<figure class="my-8"></figure>');
        if ($img.attr("alt")) {
          $img.after(
            `<figcaption class="text-center text-sm text-gray-600 dark:text-gray-400 mt-2">${$img.attr(
              "alt"
            )}</figcaption>`
          );
        }
      }
    });

    return $.html();
  }

  generateExcerpt(content, maxLength = 160) {
    if (!content) return "";

    const textContent = content.replace(/<[^>]*>/g, " ");
    const cleanText = textContent.replace(/\s+/g, " ").trim();

    if (cleanText.length <= maxLength) return cleanText;

    const truncated = cleanText.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(" ");

    return lastSpace > maxLength * 0.8
      ? truncated.substring(0, lastSpace) + "..."
      : truncated + "...";
  }

  extractSubstackId(guid) {
    let guidString = "";
    if (typeof guid === "string") {
      guidString = guid;
    } else if (typeof guid === "object") {
      guidString = guid._ || guid.text || guid.value || JSON.stringify(guid);
    } else {
      guidString = String(guid);
    }

    const match = guidString.match(/\/p\/([^\/]+)/);
    if (match) return match[1];

    const substackMatch = guidString.match(/([a-zA-Z0-9-]+)\.substack\.com/);
    if (substackMatch) return substackMatch[1];

    return (
      guidString.replace(/[^\w-]/g, "").substring(0, 50) ||
      Date.now().toString()
    );
  }

  extractTags(category) {
    if (!category) return [];
    if (Array.isArray(category)) return category;
    return [category];
  }

  calculateReadingTime(content) {
    if (!content) return 0;
    const textContent = content.replace(/<[^>]*>/g, " ");
    const wordCount = textContent.trim().split(/\s+/).length;
    return Math.ceil(wordCount / 200);
  }

  processSubstackEmbeds(content) {
    const $ = cheerio.load(content);

    $('blockquote[class*="twitter"]').each((i, elem) => {
      const $tweet = $(elem);
      const tweetUrl = $tweet.find("a").last().attr("href");
      if (tweetUrl) {
        $tweet.replaceWith(`
          <div class="twitter-embed my-8 p-4 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-800">
              <p class="text-gray-600 dark:text-gray-400 mb-2">📱 Twitter Post</p>
              <a href="${tweetUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 hover:underline">
                  View on Twitter →
              </a>
          </div>
        `);
      }
    });

    $('iframe[src*="youtube.com"], iframe[src*="youtu.be"]').each((i, elem) => {
      const $iframe = $(elem);
      $iframe.addClass("w-full aspect-video rounded-lg my-8");
      $iframe.wrap('<div class="relative"></div>');
    });

    return $.html();
  }
}

module.exports = new SubstackService();
