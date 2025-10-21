/**
 * Simple in-memory cache manager
 * Used to cache frequently accessed data to reduce database load
 */
class CacheManager {
  constructor() {
    this.cache = {};
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0
    };

    // Run cache cleanup every 10 minutes
    // Use unref() so it doesn't keep Node alive during tests
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Destroy the cache manager and clear cleanup interval
   * Used for cleanup in tests
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }

  /**
   * Set a value in the cache with optional TTL
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in milliseconds (default: 5 minutes)
   */
  set(key, value, ttl = 5 * 60 * 1000) {
    this.cache[key] = {
      value,
      expiry: Date.now() + ttl
    };
    this.stats.sets++;
  }

  /**
   * Get a value from the cache
   * @param {string} key - Cache key
   * @returns {any|null} - Cached value or null if not found or expired
   */
  get(key) {
    const item = this.cache[key];
    if (!item) {
      this.stats.misses++;
      return null;
    }
    
    if (item.expiry < Date.now()) {
      delete this.cache[key];
      this.stats.evictions++;
      this.stats.misses++;
      return null;
    }
    
    this.stats.hits++;
    return item.value;
  }

  /**
   * Check if a key exists in the cache and is not expired
   * @param {string} key - Cache key
   * @returns {boolean} - True if key exists and is not expired
   */
  has(key) {
    const item = this.cache[key];
    if (!item) return false;
    if (item.expiry < Date.now()) {
      delete this.cache[key];
      this.stats.evictions++;
      return false;
    }
    return true;
  }

  /**
   * Remove a key from the cache
   * @param {string} key - Cache key
   */
  delete(key) {
    delete this.cache[key];
  }

  /**
   * Clear all items from the cache
   */
  clear() {
    this.cache = {};
  }

  /**
   * Clean up expired items from the cache
   */
  cleanup() {
    const now = Date.now();
    let evicted = 0;
    
    Object.keys(this.cache).forEach(key => {
      if (this.cache[key].expiry < now) {
        delete this.cache[key];
        evicted++;
      }
    });
    
    if (evicted > 0) {
      this.stats.evictions += evicted;
      console.log(`Cache cleanup: removed ${evicted} expired items`);
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} - Cache statistics
   */
  getStats() {
    return {
      ...this.stats,
      size: Object.keys(this.cache).length,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0
    };
  }
}

module.exports = new CacheManager(); 