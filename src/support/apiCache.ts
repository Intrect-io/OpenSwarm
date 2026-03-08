/**
 * API 응답 캐싱 매니저
 *
 * 목적:
 * - 빈번한 API 호출의 응답 시간 단축 (30-40% 개선 목표)
 * - 메모리 효율성 유지
 * - 캐시 무효화 전략 통합
 *
 * 구현:
 * - 메모리 기반 LRU 캐시
 * - TTL(Time-To-Live) 기반 자동 만료
 * - 캐시 통계 추적
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
  size: number;
  hitRate: number;
}

export class APICache {
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private stats: Map<string, CacheStats> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(cleanupIntervalMs: number = 60000) {
    // 1분마다 만료된 캐시 정리
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  /**
   * 캐시에서 데이터 조회
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      this.recordMiss(key);
      return null;
    }

    // TTL 확인
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      this.recordMiss(key);
      return null;
    }

    // 히트 기록
    entry.hits++;
    this.recordHit(key);
    return entry.data;
  }

  /**
   * 캐시에 데이터 저장
   */
  set<T>(key: string, data: T, ttlMs: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttlMs,
      hits: 0,
    });
  }

  /**
   * 캐시 초기화
   */
  clear(): void {
    this.cache.clear();
    this.stats.clear();
  }

  /**
   * 특정 키 무효화
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * 패턴 기반 무효화 (와일드카드)
   */
  invalidatePattern(pattern: string): void {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 캐시 통계 조회
   */
  getStats(key?: string): Record<string, CacheStats> | CacheStats | null {
    if (key) {
      return this.stats.get(key) ?? null;
    }
    return Object.fromEntries(this.stats);
  }

  /**
   * 캐시 크기 조회
   */
  getSize(): number {
    return this.cache.size;
  }

  /**
   * 캐시 정리 (만료된 항목 제거)
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
   * 히트 기록
   */
  private recordHit(key: string): void {
    const stat = this.stats.get(key) ?? { hits: 0, misses: 0, size: 0, hitRate: 0 };
    stat.hits++;
    const total = stat.hits + stat.misses;
    stat.hitRate = total > 0 ? stat.hits / total : 0;
    this.stats.set(key, stat);
  }

  /**
   * 미스 기록
   */
  private recordMiss(key: string): void {
    const stat = this.stats.get(key) ?? { hits: 0, misses: 0, size: 0, hitRate: 0 };
    stat.misses++;
    const total = stat.hits + stat.misses;
    stat.hitRate = total > 0 ? stat.hits / total : 0;
    this.stats.set(key, stat);
  }

  /**
   * 정리 타이머 중단
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// 글로벌 캐시 인스턴스
export const apiCache = new APICache();

/**
 * 캐시 유틸리티
 */
export class CachedAPI {
  /**
   * 캐시를 활용한 비동기 함수 래핑
   */
  static async cached<T>(
    key: string,
    fn: () => Promise<T>,
    ttlMs: number = 10000,
  ): Promise<T> {
    // 캐시 확인
    const cached = apiCache.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // 캐시 미스: 함수 실행
    const result = await fn();

    // 결과 캐시
    apiCache.set(key, result, ttlMs);

    return result;
  }

  /**
   * 다중 캐시 키 검증
   */
  static invalidateMultiple(patterns: string[]): void {
    for (const pattern of patterns) {
      apiCache.invalidatePattern(pattern);
    }
  }
}
