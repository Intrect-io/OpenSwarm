# Playwright 렌더링 성능 측정 스크립트

모든 프론트엔드 탭을 순회하며 렌더링 완료까지의 시간을 측정하는 자동화 스크립트입니다.

## 개요

이 스크립트는 Playwright를 활용하여 OpenSwarm 대시보드의 모든 탭에 대해 다음 메트릭을 수집합니다:

- **Navigation Time**: 페이지 이동 시간
- **DOM Content Loaded**: DOM 콘텐츠 로드 완료 시간
- **Load Complete**: 모든 리소스 로드 완료 시간
- **Render Complete**: 렌더링 완료 시간 (리플로우/리페인트 포함)
- **First Paint (FP)**: 첫 픽셀 렌더링 시간
- **First Contentful Paint (FCP)**: 첫 콘텐츠 렌더링 시간
- **Largest Contentful Paint (LCP)**: 가장 큰 콘텐츠 렌더링 시간

## 설치

```bash
npm install
```

Playwright는 `playwright` 패키지로 devDependencies에 포함되어 있습니다.

## 사용 방법

### 기본 실행

```bash
npm run perf:measure
```

또는 직접 실행:

```bash
tsx scripts/playwright-rendering-performance.ts
```

### 환경 변수를 통한 설정

```bash
# 특정 URL에 대해 테스트
BASE_URL=http://your-server:3000 npm run perf:measure

# 결과 저장 위치 변경
OUTPUT_DIR=./custom-results npm run perf:measure

# 둘 다 설정
BASE_URL=http://localhost:8080 OUTPUT_DIR=./performance-data npm run perf:measure
```

## 측정되는 탭 목록

다음 3개 탭이 순회되며 측정됩니다:

1. **REPOS** - 저장소 관리
2. **PIPELINE** - 파이프라인 및 로그 조회
3. **CHAT** - 에이전트 채팅

## 출력 형식

### JSON 형식 (`rendering-metrics-TIMESTAMP.json`)

```json
{
  "tabs": [
    {
      "tab": "REPOS",
      "startTime": 0,
      "navigationEnd": 1234.56,
      "domContentLoaded": 2345.67,
      "loadComplete": 3456.78,
      "renderComplete": 4567.89,
      "totalRenderTime": 4567.89,
      "firstContentfulPaint": 1500.23,
      "largestContentfulPaint": 2800.45,
      "navigationTiming": {
        "navigationStart": 0,
        "domContentLoadedEventEnd": 2345.67,
        "loadEventEnd": 3456.78
      }
    }
    // ... 더 많은 탭 데이터
  ],
  "summary": {
    "averageRenderTime": 3000.45,
    "minRenderTime": 1500.23,
    "maxRenderTime": 5000.12,
    "totalTime": 15000.00,
    "timestamp": "2026-03-07T13:25:21.303Z"
  }
}
```

### CSV 형식 (`rendering-metrics-TIMESTAMP.csv`)

| Tab | Total (ms) | Navigation (ms) | DOMContentLoaded (ms) | Load Complete (ms) | Render Complete (ms) | FCP (ms) | LCP (ms) |
|-----|-----------|-----------------|----------------------|-------------------|---------------------|---------|---------|
| REPOS | 4567.89 | 1234.56 | 2345.67 | 3456.78 | 4567.89 | 1500.23 | 2800.45 |
| PIPELINE | 3456.78 | 1100.45 | 2200.56 | 3100.67 | 3456.78 | 1400.23 | 2500.34 |
| CHAT | 5234.56 | 1400.78 | 2500.89 | 3600.90 | 5234.56 | 1600.45 | 3000.67 |

## 결과 분석

### 성능 지표 해석

- **Total Render Time**: 전체 렌더링 시간. 이 값이 낮을수록 좋습니다.
- **FCP < 2000ms**: 좋음
- **LCP < 2500ms**: 좋음
- **전체 렌더링 < 3000ms**: 목표

### 성능 문제 식별

스크립트는 자동으로 평균 렌더링 시간의 1.5배 이상인 탭을 "성능 문제 탭"으로 표시합니다:

```
⚠️  성능 문제 탭 (평균의 1.5배 이상):
  - instances: 5234.56ms
  - sessions: 4890.12ms
```

## 실제 사용 예시

### 1. 기본 성능 테스트 (로컬 개발 서버)

```bash
# 1. OpenSwarm 대시보드 서버 시작
npm run dev

# 2. 다른 터미널에서 성능 측정 (기본값: localhost:5173)
npm run perf:measure
```

### 2. 프로덕션 환경 성능 측정

```bash
BASE_URL=https://your-openswarm-domain.com npm run perf:measure
```

### 3. 사용자 정의 결과 저장 디렉토리

```bash
OUTPUT_DIR=./custom-results npm run perf:measure
```

## 성능 최적화 팁

스크립트 실행 결과를 기반으로 다음과 같이 최적화할 수 있습니다:

### 렌더링 시간 감소
- 불필요한 리렌더링 제거
- 가상화 (virtualization) 구현
- 코드 스플리팅 적용

### FCP 개선
- 중요한 리소스 우선로드
- 인라인 크리티컬 CSS
- 폰트 최적화

### LCP 개선
- 이미지 최적화
- 지연 로딩 (Lazy Loading) 적용
- 리소스 압축

## 자동화 (CI/CD)

GitHub Actions 또는 다른 CI/CD 파이프라인에서 정기적으로 실행할 수 있습니다:

```yaml
# .github/workflows/performance.yml
name: Performance Test
on:
  schedule:
    - cron: '0 0 * * *'  # 매일 자정 실행

jobs:
  perf-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '22'
      - run: npm install
      - name: Start UI server
        run: cd openclaw/ui && npm run dev &
      - name: Wait for server
        run: sleep 5
      - name: Run performance test
        run: npm run perf:measure
      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: performance-results
          path: performance-results/
```

## 트러블슈팅

### 연결 거부 오류 (net::ERR_CONNECTION_REFUSED)

**원인**: 지정된 BASE_URL에서 서버가 실행 중이 아님

**해결책**:
```bash
# 1. UI 서버 실행 확인
cd openclaw/ui && npm run dev

# 2. 다른 포트에서 실행 중인 경우
BASE_URL=http://localhost:3000 npm run perf:measure
```

### 타임아웃 오류

**원인**: 페이지 로딩이 오래 걸림

**해결책**:
- 네트워크 연결 확인
- 브라우저 개발자 도구에서 렌더링 성능 확인
- 페이지 리소스 최적화 고려

### Playwright 설치 오류

**원인**: Playwright 브라우저 바이너리가 없음

**해결책**:
```bash
npx playwright install chromium
```

## 추가 리소스

- [Playwright 공식 문서](https://playwright.dev/)
- [Web Vitals 가이드](https://web.dev/vitals/)
- [성능 최적화 가이드](https://web.dev/performance/)

## 라이선스

OpenSwarm 프로젝트와 동일한 라이선스를 따릅니다.
