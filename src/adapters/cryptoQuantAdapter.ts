// ============================================
// CryptoQuant API Adapter
// Stablecoin Exchange Flow Analysis
// USDC Netflow data integration for Risk-On signals
// ============================================

import * as https from 'https';

/**
 * USDC Exchange Netflow data point
 */
export interface USDCNetflowData {
  timestamp: number;          // Unix timestamp (Day)
  date: string;               // ISO date string (YYYY-MM-DD)
  exchange: string;           // Exchange name (e.g., "binance", "coinbase")
  netflow: number;            // Net inflow in USDC (positive = inflow, negative = outflow)
  inflow: number;             // Inflow amount
  outflow: number;            // Outflow amount
  token: string;              // Token identifier (e.g., "usdc_eth")
}

/**
 * Risk-On Signal Analysis Result
 */
export interface RiskOnSignal {
  score: number;              // 0-100 scale (0=risk-off, 100=risk-on)
  trend: 'increasing' | 'decreasing' | 'stable';
  netflowTrend: number;       // Average netflow over period
  cexInflowStrength: number;  // Strength of CEX inflow (0-100)
  cexOutflowStrength: number; // Strength of CEX outflow (0-100)
  confidence: number;         // 0-100 confidence level
  lastUpdated: number;        // Unix timestamp
  recommendation: string;     // Human-readable insight
}

/**
 * CryptoQuantAdapter configuration
 */
export interface CryptoQuantConfig {
  apiToken: string;
  baseUrl?: string;
  cacheDir?: string;
  rateLimitPerDay?: number;
  dataWindow?: number;        // Days of historical data to fetch
}

/**
 * Rate limit state
 */
interface RateLimitState {
  requestsToday: number;
  lastResetDate: string;
}

// ============================================
// CryptoQuantAdapter Class
// ============================================

export class CryptoQuantAdapter {
  private apiToken: string;
  private baseUrl: string;
  private cacheDir: string;
  private rateLimitPerDay: number;
  private dataWindow: number;
  private rateLimitState: RateLimitState;

  constructor(config: CryptoQuantConfig) {
    this.apiToken = config.apiToken;
    this.baseUrl = config.baseUrl || 'https://api.cryptoquant.com/v1';
    this.cacheDir = config.cacheDir || './cache/cryptoquant';
    this.rateLimitPerDay = config.rateLimitPerDay || 50;
    this.dataWindow = config.dataWindow || 7; // Default 7 days
    this.rateLimitState = {
      requestsToday: 0,
      lastResetDate: new Date().toISOString().slice(0, 10),
    };
  }

  /**
   * Fetch USDC Netflow data from CryptoQuant
   * @param exchange - Exchange name (e.g., "binance", "coinbase", "kraken")
   * @param daysBack - Number of days back from today (default: 7)
   */
  async getUSDCNetflow(exchange: string, daysBack: number = 7): Promise<USDCNetflowData[]> {
    // Check rate limit
    this.checkRateLimit();

    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - daysBack * 24 * 60 * 60 * 1000);

    const fromStr = fromDate.toISOString().slice(0, 10).replace(/-/g, '');
    const toStr = toDate.toISOString().slice(0, 10).replace(/-/g, '');

    const params = {
      token: 'usdc_eth',      // USDC on Ethereum
      exchange: exchange,
      window: 'day',
      from: fromStr,
      to: toStr,
      limit: daysBack,
    };

    const queryString = new URLSearchParams(params as any).toString();
    const url = `${this.baseUrl}/stablecoin/exchange-flows/netflow?${queryString}`;

    console.log(`[CryptoQuantAdapter] Fetching USDC Netflow: ${exchange} (${daysBack}d)`);

    try {
      const response = await this.makeRequest(url);
      if (!response.data || !Array.isArray(response.data)) {
        console.warn('[CryptoQuantAdapter] Unexpected response format:', response);
        return [];
      }

      // Transform API response to USDCNetflowData
      const data: USDCNetflowData[] = response.data.map((item: any) => ({
        timestamp: item.timestamp || Math.floor(new Date(item.date).getTime() / 1000),
        date: item.date,
        exchange: exchange,
        netflow: item.netflow || (item.inflow - item.outflow),
        inflow: item.inflow,
        outflow: item.outflow,
        token: 'usdc_eth',
      }));

      this.recordApiCall();
      return data;
    } catch (err) {
      console.error('[CryptoQuantAdapter] API error:', err);
      throw err;
    }
  }

  /**
   * Fetch USDC Netflow from multiple exchanges
   */
  async getUSDCNetflowMultiExchange(
    exchanges: string[] = ['binance', 'coinbase', 'kraken'],
    daysBack: number = 7
  ): Promise<Map<string, USDCNetflowData[]>> {
    const results = new Map<string, USDCNetflowData[]>();

    for (const exchange of exchanges) {
      try {
        const data = await this.getUSDCNetflow(exchange, daysBack);
        results.set(exchange, data);
      } catch (err) {
        console.warn(`[CryptoQuantAdapter] Failed to fetch ${exchange}:`, err);
        results.set(exchange, []);
      }
    }

    return results;
  }

  /**
   * Analyze USDC Netflow data for Risk-On signal
   */
  analyzeRiskOnSignal(data: USDCNetflowData[]): RiskOnSignal {
    if (data.length === 0) {
      return {
        score: 50,
        trend: 'stable',
        netflowTrend: 0,
        cexInflowStrength: 0,
        cexOutflowStrength: 0,
        confidence: 0,
        lastUpdated: Date.now(),
        recommendation: '데이터 부족으로 신호를 분석할 수 없습니다.',
      };
    }

    // Sort by timestamp
    const sorted = [...data].sort((a, b) => a.timestamp - b.timestamp);

    // Calculate netflow trend (recent vs older)
    const recent = sorted.slice(-3);
    const older = sorted.slice(0, Math.max(1, sorted.length - 3));

    const recentNetflow = recent.reduce((sum, d) => sum + d.netflow, 0) / recent.length;
    const olderNetflow = older.reduce((sum, d) => sum + d.netflow, 0) / older.length;

    const netflowTrend = recentNetflow - olderNetflow;
    const trend = netflowTrend > 100 ? 'increasing' : netflowTrend < -100 ? 'decreasing' : 'stable';

    // Calculate inflow/outflow strength
    const totalInflow = sorted.reduce((sum, d) => sum + d.inflow, 0);
    const totalOutflow = sorted.reduce((sum, d) => sum + d.outflow, 0);
    const totalFlow = totalInflow + totalOutflow;

    const inflowRatio = totalFlow > 0 ? totalInflow / totalFlow : 0.5;
    const outflowRatio = totalFlow > 0 ? totalOutflow / totalFlow : 0.5;

    // Risk-On Score calculation
    // 위험자산 선호: CEX inflow 증가 = 구매압 증가
    // 위험자산 회피: CEX outflow 증가 = 판매압 증가
    const inflowScore = Math.min(100, inflowRatio * 200);      // 0-100
    const outflowScore = Math.min(100, outflowRatio * 200);    // 0-100
    const trendScore = Math.min(100, Math.max(0, 50 + (netflowTrend / 1000) * 50)); // 0-100

    const score = Math.round((inflowScore * 0.5 + trendScore * 0.5));

    // Confidence based on data consistency
    const variance = this.calculateVariance(sorted.map(d => d.netflow));
    const confidence = Math.round(Math.max(0, Math.min(100, 100 - variance / 100)));

    // Recommendation
    let recommendation = '';
    if (score > 65) {
      recommendation = '🟢 위험자산 선호 신호 (Risk-On): CEX 유입이 강함';
    } else if (score < 35) {
      recommendation = '🔴 위험자산 회피 신호 (Risk-Off): CEX 유출이 강함';
    } else {
      recommendation = '🟡 중립: 명확한 신호 없음';
    }

    return {
      score,
      trend,
      netflowTrend,
      cexInflowStrength: Math.round(inflowScore),
      cexOutflowStrength: Math.round(outflowScore),
      confidence,
      lastUpdated: Date.now(),
      recommendation,
    };
  }

  /**
   * Private: Make HTTPS request
   */
  private async makeRequest(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      https.get(
        url,
        {
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'User-Agent': 'OpenSwarm/1.0',
          },
        },
        (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (res.statusCode !== 200) {
                reject(new Error(`CryptoQuant API error: ${res.statusCode} ${json.message || ''}`));
              } else {
                resolve(json);
              }
            } catch (err) {
              reject(new Error(`Failed to parse CryptoQuant response: ${err}`));
            }
          });
        }
      ).on('error', reject);
    });
  }

  /**
   * Private: Check rate limit
   */
  private checkRateLimit(): void {
    const today = new Date().toISOString().slice(0, 10);

    if (today !== this.rateLimitState.lastResetDate) {
      this.rateLimitState.requestsToday = 0;
      this.rateLimitState.lastResetDate = today;
    }

    if (this.rateLimitState.requestsToday >= this.rateLimitPerDay) {
      throw new Error(`[CryptoQuantAdapter] Rate limit exceeded: ${this.rateLimitPerDay} requests/day`);
    }
  }

  /**
   * Private: Record API call
   */
  private recordApiCall(): void {
    this.rateLimitState.requestsToday++;
    console.log(`[CryptoQuantAdapter] API calls today: ${this.rateLimitState.requestsToday}/${this.rateLimitPerDay}`);
  }

  /**
   * Private: Calculate variance for confidence
   */
  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;

    const mean = values.reduce((a, b) => a + b) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b) / values.length;

    return Math.sqrt(variance); // Return standard deviation
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(): { used: number; limit: number; remaining: number } {
    return {
      used: this.rateLimitState.requestsToday,
      limit: this.rateLimitPerDay,
      remaining: Math.max(0, this.rateLimitPerDay - this.rateLimitState.requestsToday),
    };
  }
}

// ============================================
// Singleton Instance
// ============================================

let adapterInstance: CryptoQuantAdapter | null = null;

export function initCryptoQuantAdapter(config: CryptoQuantConfig): CryptoQuantAdapter {
  adapterInstance = new CryptoQuantAdapter(config);
  return adapterInstance;
}

export function getCryptoQuantAdapter(): CryptoQuantAdapter {
  if (!adapterInstance) {
    throw new Error('CryptoQuantAdapter not initialized. Call initCryptoQuantAdapter() first.');
  }
  return adapterInstance;
}
