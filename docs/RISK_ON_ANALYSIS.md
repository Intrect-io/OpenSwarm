# Risk-On Analysis: USDC Netflow Signal Integration

## Overview

Risk-On analysis evaluates cryptocurrency market sentiment using USDC (stablecoin) exchange netflow data from **CryptoQuant**. This integration helps OpenSwarm make context-aware decisions about project execution timing based on broader market conditions.

**Key Insight**: When risk assets are preferred (Risk-On), exchanges see net inflows of USDC. When risk assets are avoided (Risk-Off), exchanges see net outflows as traders move to stablecoins.

## Architecture

### Components

#### 1. CryptoQuantAdapter (`src/adapters/cryptoQuantAdapter.ts`)
- **Purpose**: API wrapper for CryptoQuant USDC Netflow endpoint
- **Responsibilities**:
  - Fetch USDC exchange netflow data
  - Rate limit management (50 requests/day)
  - Data transformation and aggregation
  - Risk-On signal analysis

**Key Methods**:
- `getUSDCNetflow(exchange, daysBack)` - Fetch single exchange data
- `getUSDCNetflowMultiExchange(exchanges, daysBack)` - Fetch multiple exchanges
- `analyzeRiskOnSignal(data)` - Calculate Risk-On score and signals

**Output**:
```typescript
interface RiskOnSignal {
  score: number;              // 0-100 (>50 = Risk-On)
  trend: 'increasing' | 'decreasing' | 'stable';
  netflowTrend: number;       // Average netflow change
  cexInflowStrength: number;  // 0-100 (inflow dominance)
  cexOutflowStrength: number; // 0-100 (outflow dominance)
  confidence: number;         // 0-100 (data stability)
  recommendation: string;     // Human-readable insight
}
```

#### 2. RiskOnAnalyzer (`src/knowledge/riskOnAnalyzer.ts`)
- **Purpose**: Market sentiment analysis engine
- **Responsibilities**:
  - Aggregate exchange data
  - Determine market sentiment level
  - Cache analysis results (60 min TTL)
  - Generate execution recommendations

**Sentiment Levels**:
- `strong-risk-on` (score ≥75): Accelerate development/deployment
- `moderate-risk-on` (60-74): Normal pace recommended
- `neutral` (40-59): Base metrics apply
- `moderate-risk-off` (25-39): Cautious pace suggested
- `strong-risk-off` (<25): Major changes deferred

**Output**:
```typescript
interface RiskOnAnalysis {
  sentiment: MarketSentiment;
  score: number;
  signals: {
    usdc: RiskOnSignal;
    exchanges: Map<string, RiskOnSignal>;  // Per-exchange breakdown
  };
  executionRecommendation: string;
  healthImpact: {
    weightToApply: number;    // 0-1 (impact factor)
    suggestion: string;
  };
}
```

#### 3. ProjectUpdater Integration (`src/linear/projectUpdater.ts`)
- **Purpose**: Integrate Risk-On signals into project health assessment
- **Changes**:
  - `determineHealth()` - Now weights Risk-On sentiment
  - Status updates include market sentiment section
  - Linear issues receive Risk-On recommendations

### Data Flow

```
┌─────────────────────────┐
│   Daily Report Trigger  │
└────────────┬────────────┘
             │
             v
┌─────────────────────────────────────┐
│    projectUpdater.postStatusUpdate   │
└────────────┬────────────────────────┘
             │
             ├─> collectProjectMetrics()
             ├─> collectKnowledgeMetrics()
             └─> collectRiskOnMetrics()  ← NEW
                        │
                        v
             ┌──────────────────────┐
             │  RiskOnAnalyzer      │
             ├──────────────────────┤
             │ 1. Check cache       │
             │ 2. If expired:       │
             │    - Fetch USDC data │
             │    - Aggregate flows │
             │    - Analyze signals │
             │    - Cache result    │
             └────────┬─────────────┘
                      │
                      v
           ┌────────────────────────┐
           │ CryptoQuantAdapter     │
           ├────────────────────────┤
           │ API: CryptoQuant v1    │
           │ Endpoint: /stablecoin/ │
           │   exchange-flows/      │
           │   netflow              │
           └────────────────────────┘
                      │
                      v
           ┌────────────────────────┐
           │ determineHealth()      │
           ├────────────────────────┤
           │ - Base metrics: 100pts │
           │ - Adjustments: -/+     │
           │ - Risk-On weight:      │
           │   ±(score-50)*weight   │
           │ - Final: 0-100         │
           └────────┬───────────────┘
                    │
                    v
           ┌────────────────────────┐
           │ createProjectUpdate()  │
           │ (Linear API)           │
           └────────────────────────┘
```

## Configuration

### Environment Variables
```bash
CRYPTOQUANT_API_TOKEN="your-api-token"
```

Obtain API token from: https://cryptoquant.com

### Service Initialization (core/service.ts)
```typescript
// Auto-initialized in startService() if CRYPTOQUANT_API_TOKEN is set
const adapter = initCryptoQuantAdapter({
  apiToken: process.env.CRYPTOQUANT_API_TOKEN,
  cacheDir: './cache/cryptoquant',
  rateLimitPerDay: 50,
  dataWindow: 7,
});

const analyzer = initRiskOnAnalyzer({
  cryptoQuantAdapter: adapter,
  cacheDir: './cache/risk-on',
  cacheTTLMinutes: 60,
  exchanges: ['binance', 'coinbase', 'kraken'],
  daysBack: 7,
});
```

## API Constraints & Limits

| Constraint | Value | Impact |
|-----------|-------|--------|
| Request Limit | 50/day | Caching (60 min TTL) reduces calls |
| Data Granularity | Daily | Window: last 7 days |
| Token Coverage | USDC-ETH | Ethereum-based USDC only |
| Exchanges Included | 3+ | Binance, Coinbase, Kraken, etc. |

**Rate Limit Strategy**:
- Cache results for 60 minutes
- Aggregate from 3 major exchanges in single call
- One daily report trigger = ~1 API call

## Usage Examples

### Direct Adapter Usage
```typescript
import { getCryptoQuantAdapter } from 'src/adapters/cryptoQuantAdapter.js';

const adapter = getCryptoQuantAdapter();

// Fetch Binance USDC netflow (last 7 days)
const binanceData = await adapter.getUSDCNetflow('binance', 7);

// Analyze signal
const signal = adapter.analyzeRiskOnSignal(binanceData);
console.log(`Risk-On Score: ${signal.score}/100`);
console.log(`Recommendation: ${signal.recommendation}`);
```

### RiskOnAnalyzer Usage
```typescript
import { getRiskOnAnalyzer } from 'src/knowledge/riskOnAnalyzer.js';

const analyzer = getRiskOnAnalyzer();

// Full market analysis
const analysis = await analyzer.analyze();
console.log(`Market Sentiment: ${analysis.sentiment}`);
console.log(`Execution Recommendation: ${analysis.executionRecommendation}`);

// Summary for Linear comments
const summary = analyzer.formatSummary();
```

### ProjectUpdater Integration
```typescript
// Called daily by dailyReporter
await postStatusUpdate(
  projectId,
  projectName,
  projectPath
);

// Output: Status update includes Risk-On section
// Health score adjusted by market sentiment
```

## Linear Project Status Updates

Risk-On signals appear in daily project status updates:

```markdown
### Market Sentiment (CryptoQuant USDC Netflow)
**Signal**: 🟢 위험자산 선호 신호 (Risk-On): CEX 유입이 강함
**Score**: 72/100 (moderate-risk-on)
**Data Age**: 15min
**Exchange Flows**:
- Binance: 68% inflow, confidence 85%
- Coinbase: 72% inflow, confidence 78%
- Kraken: 65% inflow, confidence 80%
**Execution Impact**: 예정된 계획대로 진행해도 좋습니다.
```

## Health Score Impact

Risk-On sentiment adjusts project health scores:

```
Base Health Score: 100 points

Adjustment = (Risk-On Score - 50) × Health Weight
            = (72 - 50) × 0.5
            = +11 points

Final Score = 100 + adjustments + risk-on adjustment
```

**Weight Application by Sentiment**:
- `strong-risk-on`: weight = 0.8 (major impact)
- `moderate-risk-on`: weight = 0.5 (moderate impact)
- `neutral`: weight = 0.3 (minimal impact)
- `moderate-risk-off`: weight = 0.5 (moderate negative)
- `strong-risk-off`: weight = 0.8 (major negative)

## Interpretation Guide

### USDC Netflow Signals

**Positive Netflow (Inflow > Outflow)**:
- Traders moving funds TO exchanges
- Preparation for risk asset purchases
- Risk-On market sentiment
- → Accelerate execution

**Negative Netflow (Outflow > Inflow)**:
- Traders moving funds FROM exchanges
- Retreat to stablecoins/cold storage
- Risk-Off market sentiment
- → Defer major changes

**Trend Analysis**:
- Increasing inflow: Risk-On momentum building
- Decreasing inflow: Risk-On momentum weakening
- Stable pattern: Market indecision or consolidation

## Testing

Run tests:
```bash
npm test -- src/__tests__/cryptoQuantAdapter.test.ts
```

Test coverage includes:
- Rate limit tracking
- Signal analysis (Risk-On, Risk-Off, Neutral)
- Data transformation
- Trend detection
- Confidence scoring
- Edge cases (empty data, volatility)

## Future Enhancements

- [ ] Multi-timeframe analysis (hourly, 4h, 12h intraday)
- [ ] Correlation with other on-chain metrics (whale transactions, funding rates)
- [ ] ML-based sentiment confidence scoring
- [ ] Custom alert thresholds per project
- [ ] Discord notifications on sentiment shifts
- [ ] Historical trend analysis (monthly/quarterly patterns)
- [ ] Weighted multi-source signals (add other indicators)

## See Also

- **CryptoQuant API Docs**: https://cryptoquant.com/ko/docs
- **Stablecoin Market Dynamics**: https://cryptoquant.com/en/insights/stablecoin
- **ProjectUpdater**: `src/linear/projectUpdater.ts`
- **Decision Engine**: `src/orchestration/decisionEngine.ts`
