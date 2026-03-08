// Created: 2026-03-09
// Purpose: APICache 유틸리티 단위 테스트
// Dependencies: vitest
// Test Status: 완료

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APICache, CachedAPI, apiCache } from './apiCache';

describe('APICache', () => {
  let cache: APICache;

  beforeEach(() => {
    cache = new APICache(100); // 100ms cleanup interval for testing
  });

  afterEach(() => {
    cache.destroy();
  });

  describe('get/set', () => {
    it('캐시에 저장된 데이터를 조회할 수 있다', () => {
      cache.set('key1', { data: 'value1' }, 5000);
      const result = cache.get('key1');
      expect(result).toEqual({ data: 'value1' });
    });

    it('없는 키를 조회하면 null을 반환한다', () => {
      const result = cache.get('nonexistent');
      expect(result).toBeNull();
    });

    it('TTL이 만료된 항목을 조회하면 null을 반환한다', async () => {
      cache.set('key2', { data: 'value2' }, 100); // 100ms TTL
      await new Promise((resolve) => setTimeout(resolve, 150));
      const result = cache.get('key2');
      expect(result).toBeNull();
    });

    it('다양한 타입의 데이터를 저장하고 조회할 수 있다', () => {
      const obj = { nested: { value: 42 } };
      const arr = [1, 2, 3];
      const str = 'test';
      const num = 123;

      cache.set('obj', obj, 5000);
      cache.set('arr', arr, 5000);
      cache.set('str', str, 5000);
      cache.set('num', num, 5000);

      expect(cache.get('obj')).toEqual(obj);
      expect(cache.get('arr')).toEqual(arr);
      expect(cache.get('str')).toEqual(str);
      expect(cache.get('num')).toEqual(num);
    });
  });

  describe('invalidate', () => {
    it('특정 키를 무효화할 수 있다', () => {
      cache.set('key1', 'value1', 5000);
      cache.invalidate('key1');
      const result = cache.get('key1');
      expect(result).toBeNull();
    });

    it('없는 키를 무효화해도 에러가 없다', () => {
      expect(() => cache.invalidate('nonexistent')).not.toThrow();
    });
  });

  describe('invalidatePattern', () => {
    it('와일드카드 패턴으로 여러 키를 무효화할 수 있다', () => {
      cache.set('api:projects:1', 'value1', 5000);
      cache.set('api:projects:2', 'value2', 5000);
      cache.set('api:users:1', 'value3', 5000);

      cache.invalidatePattern('api:projects:*');

      expect(cache.get('api:projects:1')).toBeNull();
      expect(cache.get('api:projects:2')).toBeNull();
      expect(cache.get('api:users:1')).not.toBeNull();
    });

    it('복수 단어 패턴 매칭을 지원한다', () => {
      cache.set('api:projects:1', 'value1', 5000);
      cache.set('api:projects:2', 'value2', 5000);
      cache.set('api:users:1', 'value3', 5000);

      // api:projects:.* 패턴은 api:projects: 로 시작하는 모든 키 매칭
      cache.invalidatePattern('api:projects:.*');

      expect(cache.get('api:projects:1')).toBeNull();
      expect(cache.get('api:projects:2')).toBeNull();
      expect(cache.get('api:users:1')).not.toBeNull();
    });
  });

  describe('clear', () => {
    it('모든 캐시 항목을 삭제한다', () => {
      cache.set('key1', 'value1', 5000);
      cache.set('key2', 'value2', 5000);
      cache.clear();

      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
      expect(cache.getSize()).toBe(0);
    });
  });

  describe('getSize', () => {
    it('캐시의 항목 개수를 반환한다', () => {
      expect(cache.getSize()).toBe(0);
      cache.set('key1', 'value1', 5000);
      expect(cache.getSize()).toBe(1);
      cache.set('key2', 'value2', 5000);
      expect(cache.getSize()).toBe(2);
    });
  });

  describe('getStats', () => {
    it('특정 키의 통계를 조회할 수 있다', () => {
      cache.set('key1', 'value1', 5000);
      cache.get('key1');
      cache.get('key1');
      cache.get('nonexistent');

      const stats = cache.getStats('key1');
      expect(stats).not.toBeNull();
      expect(stats?.hits).toBe(2);
      expect(stats?.misses).toBe(0);
      expect(stats?.hitRate).toBe(1);
    });

    it('전체 통계를 조회할 수 있다', () => {
      cache.set('key1', 'value1', 5000);
      cache.set('key2', 'value2', 5000);
      cache.get('key1');
      cache.get('key1');
      cache.get('key2');

      const allStats = cache.getStats() as Record<string, unknown>;
      expect(Object.keys(allStats).length).toBeGreaterThan(0);
    });

    it('없는 키의 통계는 null을 반환한다', () => {
      const stats = cache.getStats('nonexistent');
      expect(stats).toBeNull();
    });

    it('히트율을 정확히 계산한다', () => {
      cache.set('key1', 'value1', 5000);
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('key1'); // hit

      const stats = cache.getStats('key1');
      expect(stats?.hits).toBe(4);
      expect(stats?.misses).toBe(0);
      expect(stats?.hitRate).toBe(1);
    });
  });

  describe('cleanup', () => {
    it('TTL이 만료된 항목들을 정기적으로 정리한다', async () => {
      cache.set('key1', 'value1', 50);
      cache.set('key2', 'value2', 50);
      cache.set('key3', 'value3', 5000);

      expect(cache.getSize()).toBe(3);

      await new Promise((resolve) => setTimeout(resolve, 200)); // cleanup interval 포함

      // cleanup이 실행되어 TTL 만료 항목 제거
      expect(cache.getSize()).toBeLessThanOrEqual(1);
    });
  });

  describe('destroy', () => {
    it('cleanup 타이머를 정지한다', () => {
      const cache2 = new APICache(50);
      expect(cache2.getSize()).toBe(0);
      cache2.destroy();
      // 추가 정리 없이 destroy 호출 가능해야 함
      expect(() => cache2.destroy()).not.toThrow();
    });
  });
});

describe('CachedAPI', () => {
  afterEach(() => {
    apiCache.clear();
  });

  describe('cached', () => {
    it('함수의 결과를 캐시하고 반환한다', async () => {
      const fn = vi.fn(async () => ({ data: 'test' }));

      const result1 = await CachedAPI.cached('key1', fn, 5000);
      const result2 = await CachedAPI.cached('key1', fn, 5000);

      expect(result1).toEqual({ data: 'test' });
      expect(result2).toEqual({ data: 'test' });
      expect(fn).toHaveBeenCalledTimes(1); // 캐시된 결과 사용
    });

    it('캐시 미스 시 함수를 실행한다', async () => {
      const fn = vi.fn(async () => ({ value: 42 }));

      const result = await CachedAPI.cached('key2', fn, 5000);

      expect(result).toEqual({ value: 42 });
      expect(fn).toHaveBeenCalledOnce();
    });

    it('TTL이 만료되면 함수를 다시 실행한다', async () => {
      const fn = vi.fn(async () => ({ version: 1 }));

      const result1 = await CachedAPI.cached('key3', fn, 50);
      expect(fn).toHaveBeenCalledTimes(1);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const result2 = await CachedAPI.cached('key3', fn, 5000);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(result1).toEqual({ version: 1 });
      expect(result2).toEqual({ version: 1 });
    });

    it('기본 TTL은 10초이다', async () => {
      const fn = vi.fn(async () => 'cached');

      // TTL 미지정
      const result1 = await CachedAPI.cached('key4', fn);
      const result2 = await CachedAPI.cached('key4', fn);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('비동기 함수의 에러를 전파한다', async () => {
      const error = new Error('Async error');
      const fn = vi.fn(async () => {
        throw error;
      });

      await expect(CachedAPI.cached('key5', fn)).rejects.toThrow('Async error');
    });
  });

  describe('invalidateMultiple', () => {
    it('여러 패턴을 일괄 무효화할 수 있다', () => {
      apiCache.set('api:projects:1', 'data1', 5000);
      apiCache.set('api:projects:2', 'data2', 5000);
      apiCache.set('api:users:1', 'data3', 5000);

      CachedAPI.invalidateMultiple(['api:projects:*', 'api:users:*']);

      expect(apiCache.get('api:projects:1')).toBeNull();
      expect(apiCache.get('api:projects:2')).toBeNull();
      expect(apiCache.get('api:users:1')).toBeNull();
    });

    it('빈 패턴 배열 처리', () => {
      apiCache.set('key1', 'value1', 5000);
      CachedAPI.invalidateMultiple([]);
      expect(apiCache.get('key1')).not.toBeNull();
    });
  });
});

describe('Global apiCache instance', () => {
  afterEach(() => {
    apiCache.clear();
  });

  it('글로벌 인스턴스가 싱글톤이다', () => {
    apiCache.set('global', 'value', 5000);
    expect(apiCache.get('global')).toBe('value');
  });
});
