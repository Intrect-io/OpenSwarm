# USDC 분석 추가 레이어 구현 완료

**이슈**: INT-1252 - USDC 분석 추가 레이어
**목표**: CryptoQuant USDC Netflow 데이터를 활용하여 Risk-On 판단에 추가 신호 적용
**상태**: ✅ 완료 (구현 + 문서 + 테스트)

## 📋 구현 사항

### 1. CryptoQuant API 어댑터 (Sub-task 1)
**파일**: `src/adapters/cryptoQuantAdapter.ts` (331 lines)

#### 주요 기능
- ✅ USDC-ETH Exchange Netflow API 연동
- ✅ 다중 거래소 데이터 수집 (Binance, Coinbase, Kraken)
- ✅ Rate Limit 관리 (50회/일 자동 추적)
- ✅ Risk-On 신호 분석 (스코어, 추세, 신뢰도)

#### API 스펙
```typescript
// 단일 거래소 조회
getUSDCNetflow(exchange: string, daysBack: number): Promise<USDCNetflowData[]>

// 다중 거래소 조회
getUSDCNetflowMultiExchange(exchanges: string[], daysBack: number): Promise<Map<string, USDCNetflowData[]>>

// 신호 분석
analyzeRiskOnSignal(data: USDCNetflowData[]): RiskOnSignal
```

#### Risk-On 점수 계산 로직
```
1. 최근 vs 과거 Netflow 비교 → 추세 판단
2. 유입/유출 비율 계산 → 강도 측정
3. 분산도 기반 신뢰도 산정 (0-100)
4. 최종 스코어: 0-100 (50=중립, >50=위험자산선호)
```

**제약사항 준수**:
- API 리밋: 50회/일 (캐싱으로 최소화)
- 데이터 단위: Day (일단위)
- 기간: 7일 윈도우

---

### 2. Risk-On 분석 엔진 (Sub-task 2)
**파일**: `src/knowledge/riskOnAnalyzer.ts` (342 lines)

#### 주요 기능
- ✅ 시장 심리 분석 (5단계 레벨)
- ✅ 거래소 데이터 집계 및 가중치 적용
- ✅ 분석 결과 캐싱 (60분 TTL)
- ✅ 프로젝트 실행 권장사항 자동 생성

#### 시장 심리 수준
| 레벨 | 스코어 | 의미 | 행동 |
|------|--------|------|------|
| strong-risk-on | ≥75 | 강한 위험선호 | 개발 가속화 |
| moderate-risk-on | 60-74 | 중간 위험선호 | 정상 진행 |
| neutral | 40-59 | 중립 | 기본 메트릭 적용 |
| moderate-risk-off | 25-39 | 중간 위험회피 | 신중한 진행 |
| strong-risk-off | <25 | 강한 위험회피 | 주요 변경 보류 |

#### 캐싱 전략
```
- 분석 결과 60분 캐시 (API 호출 최소화)
- CryptoQuant 일일 리밋 자동 관리
- 캐시 무효화: 시간초과 또는 강제 새로고침
```

---

### 3. 프로젝트 건강도 통합 (Sub-task 3)
**파일**: `src/linear/projectUpdater.ts` (수정)

#### 변경 사항
✅ ProjectMetrics 구조 확장 (riskOn 필드 추가)
✅ determineHealth() 함수 개선 (Risk-On 가중치)
✅ 상태 업데이트 본문에 시장 신호 섹션 추가

#### Health Score 계산
```
최종 스코어 = 기본점수(100)
           + 성공률 조정 (-40~0)
           + 거부 회수 조정 (-20~0)
           + 추세 조정 (-15~0)
           + 기타 조정
           + Risk-On 조정: (신호점수-50) × 가중치

Risk-On 가중치 (심리 수준별):
- strong: 0.8 (±40점)
- moderate: 0.5 (±25점)
- neutral: 0.3 (±15점)
```

#### Linear 업데이트 내용
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

---

### 4. 서비스 초기화 통합 (Sub-task 4)
**파일**: `src/core/service.ts` (수정)

#### 자동 초기화
```typescript
// startService() 호출 시:
// 1. CRYPTOQUANT_API_TOKEN 환경변수 확인
// 2. CryptoQuantAdapter 인스턴스 생성
// 3. RiskOnAnalyzer 인스턴스 생성
// 4. 싱글톤으로 글로벌 접근 가능

// 사용:
const analyzer = getRiskOnAnalyzer();
const analysis = await analyzer.analyze();
```

#### 환경변수 설정
```bash
export CRYPTOQUANT_API_TOKEN="s4FHX7pzzHI9tdaJGHfXp7mVDzv4vIZmHYvFsHAd"
```

---

### 5. 테스트 스위트 (Sub-task 4)
**파일**: `src/__tests__/cryptoQuantAdapter.test.ts` (220 lines)

#### 테스트 커버리지
✅ Rate limit 추적 및 강제 테스트
✅ Risk-On 신호 분석 (정상/과도함수)
✅ Risk-Off 신호 감지
✅ 중립 신호 처리
✅ 엣지 케이스 (빈 데이터, 분산도)
✅ 신뢰도 점수 계산
✅ 추천 메시지 생성

#### 실행 방법
```bash
npm test -- src/__tests__/cryptoQuantAdapter.test.ts
```

---

### 6. 문서화
**파일**: `docs/RISK_ON_ANALYSIS.md`

#### 내용
- 전체 아키텍처 설명
- 데이터 흐름도
- API 제약사항 및 대응방안
- 설정 및 초기화 가이드
- 사용 예제
- Linear 통합 방법
- 해석 가이드
- 미래 개선사항

---

## 🔄 데이터 흐름

```
dailyReporter (매일 정각)
    ↓
postStatusUpdate()
    ├─ collectProjectMetrics()         [프로젝트 메트릭]
    ├─ collectKnowledgeMetrics()       [코드 건강도]
    └─ collectRiskOnMetrics() ← NEW    [시장 심리]
          ↓
    RiskOnAnalyzer.analyze()
          ├─ 캐시 확인 (60min TTL)
          ├─ 캐시 miss → CryptoQuantAdapter 호출
          │   ├─ getUSDCNetflowMultiExchange()
          │   ├─ analyzeRiskOnSignal() (각 거래소별)
          │   └─ 결과 캐시
          └─ 분석 완료
              ↓
    determineHealth()
          ├─ 기본 100점 시작
          ├─ 메트릭별 감점 적용
          └─ Risk-On 가중치 추가 → 최종 점수
              ↓
    linear.createProjectUpdate()
          └─ 시장 신호 섹션 포함한 상태 업데이트
```

---

## 📊 핵심 메트릭

| 항목 | 값 |
|------|-----|
| 새 파일 개수 | 3 |
| 수정 파일 개수 | 5 |
| 총 신규 코드 | 893 줄 |
| 테스트 케이스 | 13+ |
| 빌드 상태 | ✅ 성공 |
| TypeScript 컴파일 | ✅ 성공 |

---

## 🚀 사용 방법

### 시스템 관리자
```bash
# 환경변수 설정
export CRYPTOQUANT_API_TOKEN="your-token-here"

# 서비스 시작
npm start
# → CryptoQuantAdapter 및 RiskOnAnalyzer 자동 초기화
```

### 개발자 (직접 사용)
```typescript
import { getCryptoQuantAdapter, getRiskOnAnalyzer } from 'src/adapters/index.js';

// 어댑터 사용 (낮은 수준)
const adapter = getCryptoQuantAdapter();
const binanceData = await adapter.getUSDCNetflow('binance', 7);
const signal = adapter.analyzeRiskOnSignal(binanceData);

// 분석기 사용 (높은 수준)
const analyzer = getRiskOnAnalyzer();
const analysis = await analyzer.analyze();
console.log(analysis.sentiment);  // 'moderate-risk-on'
console.log(analysis.executionRecommendation);
```

### Linear 통합 (자동)
매일 정각에 프로젝트 상태 업데이트 포함:
- 📊 시장 심리 섹션 (CryptoQuant USDC Netflow)
- 📈 거래소별 유입/유출 비율
- 💡 실행 권장사항

---

## ⚙️ 설정 옵션

### 기본 설정
```typescript
// core/service.ts에서 자동 설정:
initCryptoQuantAdapter({
  apiToken: process.env.CRYPTOQUANT_API_TOKEN,
  cacheDir: './cache/cryptoquant',
  rateLimitPerDay: 50,
  dataWindow: 7,
});

initRiskOnAnalyzer({
  cryptoQuantAdapter: adapter,
  cacheDir: './cache/risk-on',
  cacheTTLMinutes: 60,
  exchanges: ['binance', 'coinbase', 'kraken'],
  daysBack: 7,
});
```

### 커스터마이징
```typescript
// 필요 시 설정 변경 가능:
const customAdapter = initCryptoQuantAdapter({
  apiToken: token,
  rateLimitPerDay: 100,        // 제한 증가
  dataWindow: 30,              // 30일 윈도우
});

const customAnalyzer = initRiskOnAnalyzer({
  cryptoQuantAdapter: customAdapter,
  cacheTTLMinutes: 120,        // 2시간 캐시
  exchanges: ['binance', 'okx', 'bybit'],  // 커스텀 거래소
});
```

---

## 🔒 보안 및 성능

### Rate Limit 관리
- API 일일 리밋: 50회 (CryptoQuant 무료 티어)
- 캐싱: 60분 (의도적 지연으로 리밋 절약)
- 요청당 3개 거래소 동시 조회 (효율성)
- **결과**: 일일 최대 5회 API 호출로 충분

### 신뢰도 산정
- 데이터 분산도 기반 신뢰도 계산
- 신뢰도 < 50% → 신호 약함 표시
- 추세 안정성 포함 (3-5일 비교)

### 실패 대응
```typescript
// Risk-On 분석 실패 시:
// 1. 로그 경고만 출력 (비-차단적)
// 2. null 반환 (선택사항)
// 3. 프로젝트 건강도는 기본 메트릭만 사용
// → 시스템 안정성 유지
```

---

## 📝 체크리스트 (Issue 분해)

### 이슈 INT-1252 분해 완료
- [x] **Sub-task 1**: CryptoQuant API 어댑터 개발
  - [x] API 클라이언트 구현
  - [x] Rate limit 관리
  - [x] 데이터 캐싱
  - [x] Risk-On 신호 분석

- [x] **Sub-task 2**: Risk-On 분석 엔진 개발
  - [x] 시장 심리 판단 로직
  - [x] 신뢰도 산정
  - [x] 실행 권장사항 생성
  - [x] 캐시 관리

- [x] **Sub-task 3**: 프로젝트 건강도 통합
  - [x] projectUpdater 확장
  - [x] Health score 조정 로직
  - [x] Linear 상태 업데이트 추가

- [x] **Sub-task 4**: 테스트 및 문서화
  - [x] 단위 테스트 작성
  - [x] API 응답 모킹
  - [x] README/ARCHITECTURE 업데이트
  - [x] 상세 가이드 문서

---

## 🔗 참고 자료

- **CryptoQuant API**: https://cryptoquant.com/ko/docs
- **Stablecoin 분석**: https://cryptoquant.com/en/insights/stablecoin
- **USDC 정보**: https://www.circle.com/usdc
- **구현 가이드**: `docs/RISK_ON_ANALYSIS.md`

---

## 🎯 다음 단계 (향후 개선)

1. **추가 신호 통합**
   - 고래 거래 (Whale Transactions)
   - 펀딩 레이트 (Funding Rates)
   - 옵션 Volume 변화

2. **ML 기반 개선**
   - 신뢰도 모델 학습
   - 예측 시그널 추가

3. **알림 및 자동화**
   - Discord 실시간 알림
   - 임계값 기반 자동 조정

4. **데이터 분석**
   - 월간/분기별 추세 분석
   - 상관관계 연구

---

**작성일**: 2026-03-09
**상태**: ✅ 완료 및 프로덕션 준비 완료
**검증**: TypeScript 빌드 ✅ 성공
