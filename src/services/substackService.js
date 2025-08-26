const axios = require("axios");
const xml2js = require("xml2js");
const config = require("../config/config");
const logger = require("../utils/logger");
const BlogPost = require("../models/blogPost");
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
        authors.push("L1Beat Team");
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

      return cleanedAuthors.length > 0 ? cleanedAuthors : ["L1Beat Team"];
    } catch (error) {
      logger.error("Error extracting authors from RSS item:", error.message);
      return ["L1Beat Team"];
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
   * Fetch RSS feed from Substack
   * @param {string} requestId - Request ID for tracking
   * @returns {Promise<Object>} Parsed RSS data
   */
  async fetchRSSFeed(requestId = "unknown") {
    try {
      logger.info(`[SUBSTACK RSS] Fetching RSS feed [${requestId}]`, {
        url: this.RSS_URL,
      });

      const response = await axios.get(this.RSS_URL, {
        timeout: this.TIMEOUT,
        headers: {
          Accept: "application/rss+xml, application/xml, text/xml",
          "User-Agent": "l1beat-blog-service",
          "Cache-Control": "no-cache",
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

            // Generate slug from title
            const slug = this.generateSlug(title);

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
              author: authors[0] || "L1Beat Team", // Keep for backward compatibility
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
          // Calculate reading time
          const readingTime = this.calculateReadingTime(postData.content);

          // Prepare data for database
          const dbData = {
            ...postData,
            readTime: readingTime,
            lastSynced: new Date(),
            syncStatus: "synced",
            // Ensure new fields have defaults
            subtitle: postData.subtitle || "",
            mainContent: postData.mainContent || postData.content,
            authors: postData.authors || ["L1Beat Team"], // UPDATED: Ensure authors array
            author: postData.authors ? postData.authors[0] : "L1Beat Team", // Keep for compatibility
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
            } [${requestId}] - Authors: ${postData.authors.join(", ")}`
          );
        } catch (postError) {
          errorCount++;
          logger.error(`[SUBSTACK SYNC] Error syncing post [${requestId}]:`, {
            title: postData.title,
            error: postError.message,
          });
        }
      }

      logger.info(`[SUBSTACK SYNC] Sync completed [${requestId}]`, {
        totalPosts: processedPosts.length,
        syncedCount,
        updatedCount,
        errorCount,
      });

      return {
        success: true,
        synced: syncedCount,
        updated: updatedCount,
        errors: errorCount,
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

  // Rest of the existing helper methods remain the same
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
