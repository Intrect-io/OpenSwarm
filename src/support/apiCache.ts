/**
 * API response cache manager
 *
 * Purpose:
 * - Shorten response time of frequent API calls (target: 30-40% improvement)
 * - Keep memory use efficient
 * - Integrate cache invalidation strategies
 *
 * Implementation:
 * - In-memory LRU cache
 * - Automatic expiry based on TTL (Time-To-Live)
 * - Cache statistics tracking
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttlMs: number;
  hits: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
}

type CacheLookup<T> = { hit: true; data: T } | { hit: false };

export class APICache {
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private stats: Map<string, CacheStats> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly maxEntries: number;
  private readonly maxStats: number;

  constructor(cleanupIntervalMs: number = 60000, maxEntries: number = 1000, maxStats: number = 2000) {
    this.maxEntries = maxEntries;
    this.maxStats = maxStats;
    // Purge expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
    this.cleanupInterval.unref?.();
  }

  /**
   * Look up data in the cache
   */
  get<T>(key: string): T | null {
    const result = this.lookup<T>(key);
    return result.hit ? result.data : null;
  }

  /**
   * Lookup for callers that must distinguish a null value as a cache hit
   */
  lookup<T>(key: string): CacheLookup<T> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      this.recordMiss(key);
      return { hit: false };
    }

    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      this.recordMiss(key);
      return { hit: false };
    }

    // Record a hit
    entry.hits++;
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.recordHit(key);
    return { hit: true, data: entry.data };
  }

  /**
   * Store data in the cache
   */
  set<T>(key: string, data: T, ttlMs: number): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttlMs,
      hits: 0,
    });
    this.evictCacheIfNeeded();
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
    this.stats.clear();
  }

  /**
   * Invalidate a specific key
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Pattern-based invalidation (wildcard)
   */
  invalidatePattern(pattern: string): void {
    if (pattern.length > 1_000) throw new Error('Cache invalidation pattern is too long');
    const regex = new RegExp(`^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`);
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Look up cache statistics
   */
  getStats(key?: string): Record<string, CacheStats> | CacheStats | null {
    if (key) {
      return this.stats.get(key) ?? null;
    }
    return Object.fromEntries(this.stats);
  }

  /**
   * Look up cache size
   */
  getSize(): number {
    return this.cache.size;
  }

  /**
   * Clean up the cache (remove expired entries)
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Record a hit
   */
  private recordHit(key: string): void {
    const stat = this.stats.get(key) ?? { hits: 0, misses: 0, hitRate: 0 };
    stat.hits++;
    const total = stat.hits + stat.misses;
    stat.hitRate = total > 0 ? stat.hits / total : 0;
    this.stats.set(key, stat);
    this.evictStatsIfNeeded();
  }

  /**
   * Record a miss
   */
  private recordMiss(key: string): void {
    const stat = this.stats.get(key) ?? { hits: 0, misses: 0, hitRate: 0 };
    stat.misses++;
    const total = stat.hits + stat.misses;
    stat.hitRate = total > 0 ? stat.hits / total : 0;
    this.stats.set(key, stat);
    this.evictStatsIfNeeded();
  }

  private evictCacheIfNeeded(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private evictStatsIfNeeded(): void {
    while (this.stats.size > this.maxStats) {
      const oldest = this.stats.keys().next().value;
      if (oldest === undefined) break;
      this.stats.delete(oldest);
    }
  }

  /**
   * Stop the cleanup timer
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Global cache instance
export const apiCache = new APICache();

/**
 * Cache utilities
 */
export class CachedAPI {
  /**
   * Wrap an async function with caching
   */
  static async cached<T>(
    key: string,
    fn: () => Promise<T>,
    ttlMs: number = 10000,
  ): Promise<T> {
    // Check the cache
    const cached = apiCache.lookup<T>(key);
    if (cached.hit) {
      return cached.data;
    }

    // Cache miss: run the function
    const result = await fn();

    // Cache the result
    apiCache.set(key, result, ttlMs);

    return result;
  }

  /**
   * Validate multiple cache keys
   */
  static invalidateMultiple(patterns: string[]): void {
    for (const pattern of patterns) {
      apiCache.invalidatePattern(pattern);
    }
  }
}
