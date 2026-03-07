# INT-1154: 500줄 이상 파일 식별 및 리팩터링 계획

**생성일**: 2026-03-07
**분석 대상**: TypeScript/JavaScript 파일 (src 디렉토리)
**총 파일 수**: 99개
**500줄 이상 파일**: 22개

---

## 1. 500줄 이상 파일 목록 (복잡도 순)

| 순번 | 파일명 | 라인 | 클래스 | 인터페이스 | 함수/메서드 | 책임 범위 |
|------|--------|------|--------|-----------|----------|---------|
| 1 | `dashboardHtml.ts` | 1,891 | 0 | 0 | 40 | **매우 높음** - HTML 템플릿 문자열 거대화 |
| 2 | `linear.ts` | 1,204 | 0 | 2 | 30 | **높음** - Linear API 통합 (다양한 쿼리) |
| 3 | `chatTui.ts` | 1,192 | 0 | 0 | 50 | **높음** - TUI 렌더링 로직 집약화 |
| 4 | `autonomousRunner.ts` | 1,045 | 1 | 0 | 81 | **극도로 높음** - 핵심 오케스트레이션 |
| 5 | `discordHandlers.ts` | 953 | 0 | 0 | 66 | **높음** - Discord 이벤트 핸들러 다중화 |
| 6 | `memoryCore.ts` | 897 | 0 | 6 | 20 | **중간** - 메모리 관리 (다양한 인터페이스) |
| 7 | `discordCore.ts` | 890 | 0 | 2 | 43 | **높음** - Discord 클라이언트 래퍼 |
| 8 | `pairPipeline.ts` | 880 | 1 | 4 | 35 | **높음** - 에이전트 페어 파이프라인 |
| 9 | `prProcessor.ts` | 875 | 1 | 1 | 44 | **높음** - PR 처리 로직 |
| 10 | `web.ts` | 787 | 0 | 1 | 23 | **중간** - 웹 서버/라우팅 |
| 11 | `memoryOps.ts` | 764 | 0 | 0 | 32 | **중간** - 메모리 연산 |
| 12 | `github.ts` | 747 | 0 | 0 | 16 | **중간** - GitHub API 통합 |
| 13 | `runnerExecution.ts` | 734 | 0 | 1 | 35 | **높음** - 실행 엔진 |
| 14 | `decisionEngine.ts` | 692 | 1 | 7 | 43 | **높음** - 의사결정 로직 |
| 15 | `taskParser.ts` | 688 | 0 | 2 | 12 | **중간** - 작업 파싱/변환 |
| 16 | `discordPair.ts` | 667 | 0 | 0 | 26 | **중간** - Discord 에이전트 페어 |
| 17 | `agentPair.ts` | 661 | 0 | 7 | 21 | **중간** - 에이전트 페어 기본 |
| 18 | `projectUpdater.ts` | 573 | 0 | 5 | 26 | **중간** - Linear 프로젝트 업데이트 |
| 19 | `config.ts` | 568 | 0 | 0 | 11 | **낮음** - 설정값 상수화 |
| 20 | `scheduler.ts` | 525 | 0 | 2 | 18 | **중간** - 작업 스케줄러 |
| 21 | `pairIntegration.test.ts` | 510 | 0 | 0 | 1 | **낮음** - 테스트 파일 |
| 22 | `runnerState.ts` | 502 | 0 | 7 | 11 | **중간** - 상태 관리 |

---

## 2. 위험도 분류 및 리팩터링 전략

### 🔴 위험도 **극도로 높음** (우선순위 1)

#### `autonomousRunner.ts` (1,045줄, 81개 함수)
**현황**: 핵심 오케스트레이션 로직이 단일 파일에 집약

**분석**:
- Heartbeat → Decision → Execution → Report 파이프라인 전체 포함
- 상태 관리, 스케줄링, 모니터링 로직 혼재
- 순환 의존성 가능성 높음

**서브이슈 분해 제안**:
1. `runnerHeartbeat.ts` - Cron 기반 하트비트 관리
2. `runnerDecision.ts` - 의사결정 로직 추출
3. `runnerMonitor.ts` - 모니터링 및 재시도 로직
4. `runnerOrchestration.ts` - 파이프라인 조율자

**예상 분할**:
- autonomousRunner.ts: ~400줄 (진입점 + 오케스트레이션)
- runnerHeartbeat.ts: ~200줄
- runnerDecision.ts: ~250줄
- runnerMonitor.ts: ~195줄

---

### 🟠 위험도 **높음** (우선순위 2)

#### `dashboardHtml.ts` (1,891줄)
**현황**: HTML 템플릿 문자열 거대화

**분석**:
- 실제 코드는 ~50줄, 나머지는 HTML 문자열
- 유지보수성 저하, 검색/수정 어려움

**서브이슈 분해 제안**:
1. `dashboardStyles.ts` - CSS 문자열 추출 (~500줄)
2. `dashboardLayout.ts` - HTML 레이아웃 컴포넌트화 (~700줄)
3. `dashboardScripts.ts` - 인라인 스크립트 분리 (~400줄)
4. `dashboardBuilder.ts` - 템플릿 조합 로직 (~50줄)

---

#### `linear.ts` (1,204줄, 30개 함수)
**현황**: Linear API 통합이 모두 한 파일에

**분석**:
- 이슈 쿼리, 프로젝트 관리, 상태 업데이트 로직 혼재
- 캐싱 레이어 포함 (48-49줄)

**서브이슈 분해 제안**:
1. `linearIssueQueries.ts` - 이슈 조회 함수들 (~300줄)
2. `linearProjectOps.ts` - 프로젝트 관리 (~250줄)
3. `linearCache.ts` - 캐싱 메커니즘 (~150줄)
4. `linearTypes.ts` - 타입 정의 분리 (~50줄)
5. `linear.ts` - 진입점만 유지 (~100줄)

---

#### `chatTui.ts` (1,192줄, 50개 함수)
**현황**: TUI 렌더링 로직 전부

**분석**:
- UI 컴포넌트, 입력 처리, 상태 관리 혼합
- 함수 50개 → 높은 순환 복잡도 예상

**서브이슈 분해 제안**:
1. `tuiComponents.ts` - 렌더링 컴포넌트 (~400줄)
2. `tuiInput.ts` - 입력 처리 (~250줄)
3. `tuiState.ts` - 상태 관리 (~250줄)
4. `chatTui.ts` - 조율자 (~200줄)

---

#### `discordHandlers.ts` (953줄, 66개 함수)
**현황**: Discord 이벤트 핸들러 대량 포함

**분석**:
- 메시지, 상호작용, 반응 핸들러 분산
- 각 핸들러 평균 ~14줄 (많은 소형 함수)

**서브이슈 분해 제안**:
1. `discordMessageHandlers.ts` - 메시지 이벤트 (~250줄)
2. `discordInteractionHandlers.ts` - 버튼/슬래시 명령 (~300줄)
3. `discordReactionHandlers.ts` - 반응 처리 (~200줄)
4. `discordHandlers.ts` - 등록/라우팅 (~200줄)

---

### 🟡 위험도 **중간** (우선순위 3)

**해당 파일들** (7개):
- `memoryCore.ts` (897줄) - 인터페이스 6개 → 기능별 분리
- `discordCore.ts` (890줄) - 클라이언트 래퍼, 로직별 분리
- `pairPipeline.ts` (880줄) - 파이프라인 단계 분리
- `prProcessor.ts` (875줄) - PR 처리 로직 단계별 분리
- `runnerExecution.ts` (734줄) - 실행 관련 로직 분리
- `decisionEngine.ts` (692줄) - 의사결정 규칙 분리
- `web.ts` (787줄) - 라우트별 분리

**통일된 전략**: 각각 300-400줄 이하의 관심사별 모듈로 분할

---

## 3. 리팩터링 영향도 분석

### 순환 의존성 위험도 높은 파일
```
autonomousRunner.ts → runnerState.ts → (others)
linear.ts → projectUpdater.ts → (others)
decisionEngine.ts → (taskParser, agents)
```

**권장사항**:
- 각 모듈 분할 시 명확한 인터페이스 정의
- 의존성 맵 재작성 필수
- 테스트 커버리지 확인 후 리팩터링

---

## 4. 예상 작업량 및 우선순위

### Phase 1 (높음 위험도, 1-2주)
1. `autonomousRunner.ts` 분할 (4개 서브파일)
2. `linear.ts` 분할 (5개 서브파일)

### Phase 2 (중간 위험도, 2-3주)
3. `chatTui.ts` 분할 (4개 서브파일)
4. `discordHandlers.ts` 분할 (4개 서브파일)
5. 나머지 중간 위험도 파일들

### Phase 3 (낮음 위험도, 1주)
6. HTML 템플릿 리팩터링
7. 각 파일별 단위 테스트 강화

---

## 5. 예상 개선 효과

| 지표 | 현재 | 목표 | 개선율 |
|------|------|------|--------|
| 평균 파일 크기 | ~350줄 | ~250줄 | 29% 감소 |
| 함수당 복잡도 | 높음 | 낮음 | ~40% 개선 |
| 테스트 커버리지 | 미측정 | >80% | 모니터링 필수 |
| 코드 리뷰 시간 | 높음 | 낮음 | ~50% 단축 |

---

## 6. 리팩터링 체크리스트

### 각 서브이슈 생성 시 포함 항목
- [ ] 책임 범위 명확화 (JSDoc)
- [ ] 테스트 커버리지 ≥80% 확보
- [ ] 의존성 다이어그램 포함
- [ ] 마이그레이션 가이드 (기존 호출자 수정)
- [ ] PR 리뷰 체크리스트

---

## 부록: 의존성 맵 (주요 파일)

```
autonomousRunner.ts (1045줄)
  ├─> runnerState.ts
  ├─> decisionEngine.ts
  ├─> runnerExecution.ts
  ├─> linear.ts
  └─> memory/*

linear.ts (1204줄)
  ├─> projectUpdater.ts
  ├─> cache (내부)
  └─> types.ts

discordHandlers.ts (953줄)
  ├─> discordCore.ts
  ├─> discordPair.ts
  └─> runnerExecution.ts
```

---

**다음 단계**: INT-1154-1부터 INT-1154-15까지 서브이슈 생성 후 순차적 진행
