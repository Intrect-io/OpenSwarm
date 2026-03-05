// ============================================
// OpenSwarm - Rate Limiter
// Prevent excessive API calls to external services
// ============================================

/**
 * Token bucket rate limiter implementation
 *
 * Features:
 * - Per-service rate limiting (Claude API, Linear API, GitHub API)
 * - Token bucket algorithm with automatic refill
 * - Queue support with configurable timeout
 * - Metrics tracking (total requests, rejected, queued)
 */

interface RateLimiterConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum queue size (0 = no queue) */
  maxQueueSize?: number;
  /** Queue timeout in milliseconds */
  queueTimeoutMs?: number;
}

interface QueuedRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timestamp: number;
}

interface RateLimiterMetrics {
  totalRequests: number;
  totalRejected: number;
  totalQueued: number;
  currentTokens: number;
  queueSize: number;
}

class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private queue: QueuedRequest[] = [];
  private metrics: RateLimiterMetrics;
  private refillInterval: NodeJS.Timeout;

  constructor(
    private readonly name: string,
    private readonly config: RateLimiterConfig
  ) {
    this.tokens = config.maxRequests;
    this.lastRefill = Date.now();
    this.metrics = {
      totalRequests: 0,
      totalRejected: 0,
      totalQueued: 0,
      currentTokens: this.tokens,
      queueSize: 0,
    };

    // Auto-refill tokens periodically
    this.refillInterval = setInterval(() => {
      this.refill();
      this.processQueue();
    }, 100); // Check every 100ms
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = (elapsed / this.config.windowMs) * this.config.maxRequests;

    this.tokens = Math.min(this.config.maxRequests, this.tokens + tokensToAdd);
    this.lastRefill = now;
    this.metrics.currentTokens = this.tokens;
  }

  /**
   * Process queued requests
   */
  private processQueue(): void {
    const now = Date.now();
    const timeout = this.config.queueTimeoutMs ?? 30000;

    while (this.queue.length > 0 && this.tokens >= 1) {
      const request = this.queue[0];

      // Check timeout
      if (now - request.timestamp > timeout) {
        this.queue.shift();
        this.metrics.queueSize = this.queue.length;
        request.reject(new Error(`[RateLimiter:${this.name}] Request timed out in queue after ${timeout}ms`));
        continue;
      }

      // Try to acquire token
      if (this.tryAcquire()) {
        this.queue.shift();
        this.metrics.queueSize = this.queue.length;
        request.resolve();
      } else {
        break; // Not enough tokens yet
      }
    }
  }

  /**
   * Try to acquire a token (non-blocking)
   */
  private tryAcquire(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.metrics.currentTokens = this.tokens;
      this.metrics.totalRequests++;
      return true;
    }

    return false;
  }

  /**
   * Acquire a token (async, with queuing)
   * @returns Promise that resolves when token is acquired
   * @throws Error if queue is full or request times out
   */
  async acquire(): Promise<void> {
    // Try immediate acquisition
    if (this.tryAcquire()) {
      return;
    }

    // Check queue size limit
    const maxQueue = this.config.maxQueueSize ?? 100;
    if (this.queue.length >= maxQueue) {
      this.metrics.totalRejected++;
      throw new Error(`[RateLimiter:${this.name}] Queue is full (${this.queue.length}/${maxQueue})`);
    }

    // Queue the request
    this.metrics.totalQueued++;
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject, timestamp: Date.now() });
      this.metrics.queueSize = this.queue.length;
    });
  }

  /**
   * Get current metrics
   */
  getMetrics(): RateLimiterMetrics {
    this.refill(); // Update current tokens
    return { ...this.metrics };
  }

  /**
   * Reset metrics (keep tokens/queue)
   */
  resetMetrics(): void {
    this.metrics.totalRequests = 0;
    this.metrics.totalRejected = 0;
    this.metrics.totalQueued = 0;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    clearInterval(this.refillInterval);
    // Reject all queued requests
    for (const request of this.queue) {
      request.reject(new Error(`[RateLimiter:${this.name}] Limiter destroyed`));
    }
    this.queue = [];
  }
}

// ============================================
// Global Rate Limiters
// ============================================

const limiters = new Map<string, RateLimiter>();

/**
 * Initialize rate limiters for known services
 */
export function initRateLimiters(): void {
  // Claude API: Conservative limit (adjust based on tier)
  // Free tier: ~50 req/min, Paid: ~1000 req/min
  limiters.set('claude', new RateLimiter('claude', {
    maxRequests: 20, // 20 requests per minute
    windowMs: 60000,
    maxQueueSize: 50,
    queueTimeoutMs: 120000, // 2 minutes timeout
  }));

  // Linear API: 5000 req/hour (from error message)
  limiters.set('linear', new RateLimiter('linear', {
    maxRequests: 80, // 80 requests per minute (4800/hour with safety margin)
    windowMs: 60000,
    maxQueueSize: 100,
    queueTimeoutMs: 60000,
  }));

  // GitHub API: 5000 req/hour (authenticated)
  limiters.set('github', new RateLimiter('github', {
    maxRequests: 80, // 80 requests per minute (4800/hour with safety margin)
    windowMs: 60000,
    maxQueueSize: 50,
    queueTimeoutMs: 60000,
  }));

  console.log('[RateLimiter] Initialized limiters: claude, linear, github');
}

/**
 * Get or create a rate limiter for a service
 */
export function getRateLimiter(service: 'claude' | 'linear' | 'github'): RateLimiter {
  const limiter = limiters.get(service);
  if (!limiter) {
    throw new Error(`[RateLimiter] No limiter configured for service: ${service}`);
  }
  return limiter;
}

/**
 * Acquire a token from a rate limiter
 * @param service Service name
 * @throws Error if rate limit exceeded or queue full
 */
export async function acquireRateLimit(service: 'claude' | 'linear' | 'github'): Promise<void> {
  const limiter = getRateLimiter(service);
  await limiter.acquire();
}

/**
 * Get metrics for all rate limiters
 */
export function getRateLimiterMetrics(): Record<string, RateLimiterMetrics> {
  const metrics: Record<string, RateLimiterMetrics> = {};
  for (const [name, limiter] of limiters) {
    metrics[name] = limiter.getMetrics();
  }
  return metrics;
}

/**
 * Reset all metrics
 */
export function resetRateLimiterMetrics(): void {
  for (const limiter of limiters.values()) {
    limiter.resetMetrics();
  }
  console.log('[RateLimiter] All metrics reset');
}

/**
 * Cleanup all rate limiters
 */
export function destroyRateLimiters(): void {
  for (const limiter of limiters.values()) {
    limiter.destroy();
  }
  limiters.clear();
  console.log('[RateLimiter] All limiters destroyed');
}

/**
 * Wrapper function for rate-limited operations
 * @param service Service name
 * @param operation Async operation to execute
 * @returns Result of the operation
 */
export async function withRateLimit<T>(
  service: 'claude' | 'linear' | 'github',
  operation: () => Promise<T>
): Promise<T> {
  await acquireRateLimit(service);
  return operation();
}
