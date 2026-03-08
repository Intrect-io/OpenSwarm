// ============================================
// CryptoQuantAdapter Tests
// ============================================

import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoQuantAdapter, type USDCNetflowData, type RiskOnSignal } from '../adapters/cryptoQuantAdapter.js';

describe('CryptoQuantAdapter', () => {
  let adapter: CryptoQuantAdapter;

  beforeEach(() => {
    adapter = new CryptoQuantAdapter({
      apiToken: 'test-token',
      cacheDir: './cache/test',
      rateLimitPerDay: 50,
      dataWindow: 7,
    });
  });

  describe('Rate Limit Management', () => {
    it('should track API calls', () => {
      const status = adapter.getRateLimitStatus();
      expect(status.limit).toBe(50);
      expect(status.used).toBe(0);
      expect(status.remaining).toBe(50);
    });

    it('should enforce rate limit', () => {
      const status = adapter.getRateLimitStatus();
      expect(status.remaining).toBeGreaterThan(0);
    });
  });

  describe('Risk-On Signal Analysis', () => {
    it('should analyze simple netflow data', () => {
      const mockData: USDCNetflowData[] = [
        {
          timestamp: 1000,
          date: '2026-03-01',
          exchange: 'binance',
          netflow: 1000000,
          inflow: 1500000,
          outflow: 500000,
          token: 'usdc_eth',
        },
        {
          timestamp: 2000,
          date: '2026-03-02',
          exchange: 'binance',
          netflow: 500000,
          inflow: 1200000,
          outflow: 700000,
          token: 'usdc_eth',
        },
      ];

      const signal = adapter.analyzeRiskOnSignal(mockData);

      expect(signal).toHaveProperty('score');
      expect(signal).toHaveProperty('trend');
      expect(signal).toHaveProperty('recommendation');
      expect(signal.score).toBeGreaterThanOrEqual(0);
      expect(signal.score).toBeLessThanOrEqual(100);
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(100);
    });

    it('should detect risk-on signal (positive netflow)', () => {
      const mockData: USDCNetflowData[] = Array.from({ length: 7 }, (_, i) => ({
        timestamp: (i + 1) * 1000,
        date: `2026-03-0${i + 1}`,
        exchange: 'binance',
        netflow: 2000000,  // Positive = inflow
        inflow: 2500000,
        outflow: 500000,
        token: 'usdc_eth',
      }));

      const signal = adapter.analyzeRiskOnSignal(mockData);

      expect(signal.score).toBeGreaterThan(50);  // Risk-on
      expect(signal.cexInflowStrength).toBeGreaterThan(50);
    });

    it('should detect risk-off signal (negative netflow)', () => {
      const mockData: USDCNetflowData[] = Array.from({ length: 7 }, (_, i) => ({
        timestamp: (i + 1) * 1000,
        date: `2026-03-0${i + 1}`,
        exchange: 'binance',
        netflow: -2000000,  // Negative = outflow
        inflow: 500000,
        outflow: 2500000,
        token: 'usdc_eth',
      }));

      const signal = adapter.analyzeRiskOnSignal(mockData);

      expect(signal.score).toBeLessThan(50);  // Risk-off
      expect(signal.cexOutflowStrength).toBeGreaterThan(50);
    });

    it('should handle empty data gracefully', () => {
      const signal = adapter.analyzeRiskOnSignal([]);

      expect(signal.score).toBe(50);  // Neutral
      expect(signal.confidence).toBe(0);
      expect(signal.trend).toBe('stable');
    });

    it('should recommend appropriate actions', () => {
      const riskOnData: USDCNetflowData[] = Array.from({ length: 7 }, (_, i) => ({
        timestamp: (i + 1) * 1000,
        date: `2026-03-0${i + 1}`,
        exchange: 'binance',
        netflow: 2000000,
        inflow: 2500000,
        outflow: 500000,
        token: 'usdc_eth',
      }));

      const signal = adapter.analyzeRiskOnSignal(riskOnData);

      expect(signal.recommendation).toContain('위험자산');
      expect(signal.recommendation).toBeTruthy();
    });
  });

  describe('Data Transformation', () => {
    it('should handle API response format', () => {
      const mockData: USDCNetflowData[] = [
        {
          timestamp: 1709000000,
          date: '2026-03-01',
          exchange: 'binance',
          netflow: 1000000,
          inflow: 1500000,
          outflow: 500000,
          token: 'usdc_eth',
        },
      ];

      const signal = adapter.analyzeRiskOnSignal(mockData);
      expect(signal.lastUpdated).toBeGreaterThan(0);
    });
  });
});

describe('Risk-On Signal Score Calculation', () => {
  let adapter: CryptoQuantAdapter;

  beforeEach(() => {
    adapter = new CryptoQuantAdapter({
      apiToken: 'test-token',
    });
  });

  it('should calculate trend correctly', () => {
    const data: USDCNetflowData[] = [
      {
        timestamp: 1000,
        date: '2026-03-01',
        exchange: 'binance',
        netflow: 500000,
        inflow: 1000000,
        outflow: 500000,
        token: 'usdc_eth',
      },
      {
        timestamp: 2000,
        date: '2026-03-02',
        exchange: 'binance',
        netflow: 1000000,
        inflow: 1500000,
        outflow: 500000,
        token: 'usdc_eth',
      },
      {
        timestamp: 3000,
        date: '2026-03-03',
        exchange: 'binance',
        netflow: 2000000,
        inflow: 2500000,
        outflow: 500000,
        token: 'usdc_eth',
      },
    ];

    const signal = adapter.analyzeRiskOnSignal(data);

    expect(signal.trend).not.toBe('stable');
    expect(signal.netflowTrend).toBeGreaterThan(0);
  });

  it('should reflect confidence in data variance', () => {
    const stableData: USDCNetflowData[] = Array.from({ length: 7 }, (_, i) => ({
      timestamp: (i + 1) * 1000,
      date: `2026-03-0${i + 1}`,
      exchange: 'binance',
      netflow: 1000000,  // Consistent
      inflow: 1500000,
      outflow: 500000,
      token: 'usdc_eth',
    }));

    const volatileData: USDCNetflowData[] = Array.from({ length: 7 }, (_, i) => ({
      timestamp: (i + 1) * 1000,
      date: `2026-03-0${i + 1}`,
      exchange: 'binance',
      netflow: i % 2 === 0 ? 5000000 : -5000000,  // Volatile
      inflow: i % 2 === 0 ? 5500000 : 500000,
      outflow: i % 2 === 0 ? 500000 : 5500000,
      token: 'usdc_eth',
    }));

    const stableSignal = adapter.analyzeRiskOnSignal(stableData);
    const volatileSignal = adapter.analyzeRiskOnSignal(volatileData);

    expect(stableSignal.confidence).toBeGreaterThan(volatileSignal.confidence);
  });
});
