// ============================================
// Risk-On Analyzer
// Cryptocurrency market sentiment analysis
// Integrates USDC Netflow signals for project health assessment
// ============================================

import { CryptoQuantAdapter, type RiskOnSignal, type USDCNetflowData } from '../adapters/cryptoQuantAdapter.js';
import * as fs from 'fs/promises';
import { resolve } from 'path';
import { homedir } from 'os';

/**
 * Market sentiment level
 */
export type MarketSentiment = 'strong-risk-on' | 'moderate-risk-on' | 'neutral' | 'moderate-risk-off' | 'strong-risk-off';

/**
 * Risk-On analysis result
 */
export interface RiskOnAnalysis {
  /** Overall market sentiment */
  sentiment: MarketSentiment;

  /** Risk-On score (0-100, >50 = risk-on) */
  score: number;

  /** USDC netflow signals */
  signals: {
    usdc: RiskOnSignal;
    exchanges: Map<string, RiskOnSignal>;
  };

  /** Data freshness */
  lastUpdated: number;
  dataAge: number;  // minutes

  /** Recommendation for project execution */
  executionRecommendation: string;

  /** Impact on project health assessment */
  healthImpact: {
    weightToApply: number;  // 0-1, how much to weight risk-on in health score
    suggestion: string;
  };
}

/**
 * Risk-On analysis configuration
 */
export interface RiskOnAnalyzerConfig {
  cryptoQuantAdapter: CryptoQuantAdapter;
  cacheDir?: string;
  cacheTTLMinutes?: number;
  exchanges?: string[];
  daysBack?: number;
}

// ============================================
// Risk-On Analyzer Class
// ============================================

export class RiskOnAnalyzer {
  private adapter: CryptoQuantAdapter;
  private cacheDir: string;
  private cacheTTLMinutes: number;
  private exchanges: string[];
  private daysBack: number;
  private lastAnalysis: RiskOnAnalysis | null = null;

  constructor(config: RiskOnAnalyzerConfig) {
    this.adapter = config.cryptoQuantAdapter;
    this.cacheDir = config.cacheDir || resolve(homedir(), '.openswarm/risk-on-cache');
    this.cacheTTLMinutes = config.cacheTTLMinutes || 60; // Cache for 1 hour
    this.exchanges = config.exchanges || ['binance', 'coinbase', 'kraken'];
    this.daysBack = config.daysBack || 7;
  }

  /**
   * Perform comprehensive Risk-On analysis
   */
  async analyze(): Promise<RiskOnAnalysis> {
    // Check cache first
    const cached = await this.loadFromCache();
    if (cached) {
      console.log('[RiskOnAnalyzer] Using cached analysis');
      this.lastAnalysis = cached;
      return cached;
    }

    console.log('[RiskOnAnalyzer] Fetching fresh data...');

    // Fetch USDC netflow from multiple exchanges
    const exchangeData = await this.adapter.getUSDCNetflowMultiExchange(this.exchanges, this.daysBack);

    // Aggregate data
    const aggregatedData = this.aggregateExchangeData(exchangeData);

    // Analyze signals
    const usdcSignal = this.adapter.analyzeRiskOnSignal(aggregatedData);

    // Per-exchange signals
    const exchangeSignals = new Map<string, RiskOnSignal>();
    for (const [exchange, data] of exchangeData) {
      const signal = this.adapter.analyzeRiskOnSignal(data);
      exchangeSignals.set(exchange, signal);
    }

    // Determine market sentiment
    const sentiment = this.determineSentiment(usdcSignal.score);

    // Generate recommendation
    const { executionRecommendation, healthImpact } = this.generateRecommendation(
      sentiment,
      usdcSignal,
      aggregatedData
    );

    const analysis: RiskOnAnalysis = {
      sentiment,
      score: usdcSignal.score,
      signals: {
        usdc: usdcSignal,
        exchanges: exchangeSignals,
      },
      lastUpdated: Date.now(),
      dataAge: 0,
      executionRecommendation,
      healthImpact,
    };

    // Save to cache
    await this.saveToCache(analysis);
    this.lastAnalysis = analysis;

    return analysis;
  }

  /**
   * Get cached analysis if valid
   */
  private async loadFromCache(): Promise<RiskOnAnalysis | null> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const cacheFile = resolve(this.cacheDir, 'latest-analysis.json');
      const content = await fs.readFile(cacheFile, 'utf-8');
      const cached = JSON.parse(content) as any;

      const ageMinutes = (Date.now() - cached.lastUpdated) / (1000 * 60);
      if (ageMinutes > this.cacheTTLMinutes) {
        console.log(`[RiskOnAnalyzer] Cache expired (${Math.round(ageMinutes)}m > ${this.cacheTTLMinutes}m)`);
        return null;
      }

      cached.dataAge = Math.round(ageMinutes);
      cached.signals.exchanges = new Map(cached.signals.exchanges);

      console.log(`[RiskOnAnalyzer] Cache valid (${Math.round(ageMinutes)}m old)`);
      return cached;
    } catch {
      return null;
    }
  }

  /**
   * Save analysis to cache
   */
  private async saveToCache(analysis: RiskOnAnalysis): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const cacheFile = resolve(this.cacheDir, 'latest-analysis.json');

      // Convert Map to array for JSON serialization
      const serializable = {
        ...analysis,
        signals: {
          usdc: analysis.signals.usdc,
          exchanges: Array.from(analysis.signals.exchanges.entries()),
        },
      };

      await fs.writeFile(cacheFile, JSON.stringify(serializable, null, 2));
      console.log('[RiskOnAnalyzer] Analysis cached');
    } catch (err) {
      console.warn('[RiskOnAnalyzer] Failed to cache:', err);
    }
  }

  /**
   * Aggregate netflow data from all exchanges
   */
  private aggregateExchangeData(
    exchangeData: Map<string, USDCNetflowData[]>
  ): USDCNetflowData[] {
    const dataByDate = new Map<string, { inflow: number; outflow: number; netflow: number }>();

    // Sum up flows by date
    for (const [_exchange, data] of exchangeData) {
      for (const point of data) {
        const existing = dataByDate.get(point.date) || { inflow: 0, outflow: 0, netflow: 0 };
        existing.inflow += point.inflow;
        existing.outflow += point.outflow;
        existing.netflow += point.netflow;
        dataByDate.set(point.date, existing);
      }
    }

    // Convert back to USDCNetflowData array
    const aggregated: USDCNetflowData[] = [];
    for (const [date, flows] of dataByDate) {
      aggregated.push({
        timestamp: Math.floor(new Date(date).getTime() / 1000),
        date,
        exchange: 'aggregated',
        netflow: flows.netflow,
        inflow: flows.inflow,
        outflow: flows.outflow,
        token: 'usdc_eth',
      });
    }

    return aggregated.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Determine market sentiment level based on score
   */
  private determineSentiment(score: number): MarketSentiment {
    if (score >= 75) return 'strong-risk-on';
    if (score >= 60) return 'moderate-risk-on';
    if (score >= 40) return 'neutral';
    if (score >= 25) return 'moderate-risk-off';
    return 'strong-risk-off';
  }

  /**
   * Generate execution recommendation based on sentiment
   */
  private generateRecommendation(
    sentiment: MarketSentiment,
    signal: RiskOnSignal,
    data: USDCNetflowData[]
  ): {
    executionRecommendation: string;
    healthImpact: RiskOnAnalysis['healthImpact'];
  } {
    const lastPoint = data[data.length - 1];
    const flowTrend = lastPoint?.netflow > 0 ? 'inflow' : 'outflow';

    switch (sentiment) {
      case 'strong-risk-on':
        return {
          executionRecommendation: '✅ 강한 위험자산 선호 신호: 공격적 개발/배포 권장',
          healthImpact: {
            weightToApply: 0.8,
            suggestion: '프로젝트 진행을 가속화하는 것이 좋습니다. 시장 심리가 긍정적입니다.',
          },
        };

      case 'moderate-risk-on':
        return {
          executionRecommendation: '🟢 위험자산 선호 신호: 정상 속도 진행 권장',
          healthImpact: {
            weightToApply: 0.5,
            suggestion: '예정된 계획대로 진행해도 좋습니다.',
          },
        };

      case 'neutral':
        return {
          executionRecommendation: '🟡 중립: 기본 계획대로 진행',
          healthImpact: {
            weightToApply: 0.3,
            suggestion: '신호가 명확하지 않으므로 기본 메트릭을 따르세요.',
          },
        };

      case 'moderate-risk-off':
        return {
          executionRecommendation: '🟠 위험자산 회피 신호: 신중한 진행 권장',
          healthImpact: {
            weightToApply: 0.5,
            suggestion: '주요 배포는 신호 개선까지 연기하는 것을 검토하세요.',
          },
        };

      case 'strong-risk-off':
        return {
          executionRecommendation: '🔴 강한 위험자산 회피 신호: 주요 변경 보류 권장',
          healthImpact: {
            weightToApply: 0.8,
            suggestion: '시장이 불리한 환경입니다. 중요한 변경은 미루고 유지보수 작업에 집중하세요.',
          },
        };
    }
  }

  /**
   * Get formatted summary for Linear comments
   */
  formatSummary(): string {
    if (!this.lastAnalysis) {
      return '📊 Risk-On 신호: 데이터 없음';
    }

    const { sentiment, score, signals, executionRecommendation, dataAge } = this.lastAnalysis;

    const exchangeDetails = Array.from(signals.exchanges.entries())
      .map(([ex, sig]) => `  - ${ex}: ${sig.cexInflowStrength}% inflow, confidence ${sig.confidence}%`)
      .join('\n');

    return `
📊 **Risk-On Market Signal Analysis**
- Sentiment: ${sentiment.toUpperCase()}
- Score: ${score}/100
- Data Age: ${dataAge}min
- Execution: ${executionRecommendation}

**Exchange Flows:**
${exchangeDetails}

*데이터: CryptoQuant USDC Netflow (7d window)*
    `.trim();
  }
}

// ============================================
// Singleton Instance
// ============================================

let analyzerInstance: RiskOnAnalyzer | null = null;

export function initRiskOnAnalyzer(config: RiskOnAnalyzerConfig): RiskOnAnalyzer {
  analyzerInstance = new RiskOnAnalyzer(config);
  return analyzerInstance;
}

export function getRiskOnAnalyzer(): RiskOnAnalyzer {
  if (!analyzerInstance) {
    throw new Error('RiskOnAnalyzer not initialized. Call initRiskOnAnalyzer() first.');
  }
  return analyzerInstance;
}
