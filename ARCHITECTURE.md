# Claude Swarm Architecture

> Autonomous CI/CD Pipeline Agent Framework by Intrect

## Overview

Claude Swarm은 Linear 이슈를 자동으로 처리하는 자율 에이전트 오케스트레이터로, Worker/Reviewer 페어 파이프라인을 통해 코드 변경을 수행하고, Discord로 모니터링하며, LanceDB 기반 장기 메모리를 유지한다.

```
                        ┌──────────────────────────┐
                        │       Linear API         │
                        │   (이슈, 상태, 코멘트)    │
                        └───────────┬──────────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                │                   │                   │
                v                   v                   v
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  AutonomousRunner │  │  DecisionEngine  │  │  TaskScheduler   │
│  (heartbeat loop) │→│  (scope guard)   │→│  (queue + slots)  │
└──────────┬───────┘  └──────────────────┘  └────────┬─────────┘
           │                                          │
           v                                          v
┌──────────────────────────────────────────────────────────────┐
│                     PairPipeline                              │
│  ┌──────┐    ┌──────────┐    ┌────────┐    ┌───────────┐    │
│  │Worker│───→│ Reviewer │───→│ Tester │───→│Documenter │    │
│  │(CLI) │←──│  (CLI)   │    │ (CLI)  │    │  (CLI)    │    │
│  └──────┘    └──────────┘    └────────┘    └───────────┘    │
│       ↕ StuckDetector                                        │
└──────────────────────────────────────────────────────────────┘
           │                    │                    │
           v                    v                    v
┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Discord Bot │  │   Memory (v2.0)  │  │  Git Tracker     │
│  (명령/보고)  │  │  LanceDB + E5   │  │  (diff tracking) │
└──────────────┘  └──────────────────┘  └──────────────────┘
```

---

## Module Dependency Graph

```
index.ts
  └→ service.ts (Main Service)
       ├→ config.ts (YAML/JSON + Zod validation + env substitution)
       ├→ discord.ts (Discord bot + chat history + project context)
       ├→ linear.ts (Linear SDK wrapper + pair mode logging)
       ├→ tmux.ts (Legacy: tmux session management)
       ├→ github.ts (CI failure monitoring via gh CLI)
       ├→ scheduler.ts (Cron job scheduling)
       ├→ web.ts (Web dashboard)
       └→ autonomousRunner.ts (Main autonomous loop)
            ├→ decisionEngine.ts (Task filtering + scope validation)
            │    ├→ workflow.ts (DAG workflow engine)
            │    ├→ taskParser.ts (Issue decomposition to subtasks)
            │    ├→ workflowExecutor.ts (Step execution)
            │    └→ timeWindow.ts (Trading hours restriction)
            ├→ taskScheduler.ts (Parallel task queue + slot management)
            ├→ pairPipeline.ts (Worker → Reviewer → Tester → Documenter)
            │    ├→ worker.ts (Claude CLI spawner + output parser)
            │    ├→ reviewer.ts (Code review agent)
            │    ├→ tester.ts (Test execution agent)
            │    ├→ documenter.ts (Documentation agent)
            │    ├→ stuckDetector.ts (Infinite loop detection)
            │    └→ agentPair.ts (Session state management)
            ├→ projectMapper.ts (Linear project → local path fuzzy matching)
            ├→ planner.ts (Large task decomposition via Claude CLI)
            ├→ memory.ts (Cognitive memory: LanceDB + Xenova embeddings)
            └→ linear.ts (Issue state + comment management)
```

---

## Core Components

### 1. Service Layer (`service.ts`)

진입점. 모든 하위 시스템을 초기화하고 연결한다.

- Linear/Discord/Web 초기화
- 에이전트 상태 관리 (`ServiceState`)
- GitHub CI 모니터링 (5분 간격)
- Heartbeat 타이머 (레거시)
- AutonomousRunner 자동 시작

### 2. Autonomous Runner (`autonomousRunner.ts`)

핵심 실행 루프. Cron 기반 heartbeat로 작업을 가져와 실행한다.

**흐름:**
1. `Cron(schedule)` → `heartbeat()` 트리거
2. `TimeWindow` 체크 (장중 시간 차단)
3. `Linear.getMyIssues()` → 할당된 이슈 조회
4. `DecisionEngine.heartbeat()` → 실행 가능 태스크 선택
5. `resolveProjectPath()` → Linear 프로젝트명 → 로컬 경로 매핑
6. `PairPipeline.run()` → Worker/Reviewer 루프 실행
7. Discord 보고 + Linear 상태 업데이트

**병렬 처리:** `heartbeatParallel()` → `DecisionEngine.heartbeatMultiple()` → `TaskScheduler` 큐

### 3. Decision Engine (`decisionEngine.ts`)

자율 행동 범위를 제한하는 게이트키퍼.

- **Scope Validation**: `allowedProjects` 화이트리스트, 명시적 issueId/workflowId 필수
- **Rate Limiting**: 쿨다운(300s), 연속작업 제한(3), 시간 윈도우
- **Task Prioritization**: priority → dueDate → createdAt 순
- **Workflow Mapping**: taskParser로 이슈 자동 파싱 → 워크플로우 생성

### 4. Pair Pipeline (`pairPipeline.ts`)

Worker → Reviewer → Tester → Documenter 스테이지 파이프라인.

- **Iteration Loop**: 최대 N회 (기본 3) Worker ↔ Reviewer 반복
- **Stuck Detection**: 같은 에러 반복, REVISE 무한 루프, 출력 반복 감지
- **Stage Roles**: 각 역할별 모델/타임아웃 설정 가능
- **Events**: `stage:start`, `stage:complete`, `stage:fail` 등

### 5. Worker Agent (`worker.ts`)

Claude CLI를 spawn하여 실제 코드 작업을 수행한다.

- 프롬프트 파일 생성 → `claude -p` 실행
- JSON 출력 파싱 (성공/실패, 변경 파일, 실행 명령)
- Git diff 기반 파일 변경 추적 (`gitTracker.ts`)
- 텍스트 fallback 파싱 (JSON 실패 시)

### 6. Reviewer Agent (`reviewer.ts`)

Worker 결과를 검토하고 APPROVE/REVISE/REJECT 결정.

- 5개 평가 기준: 정확성, 코드 품질, 테스트, 보안, 완성도
- JSON 출력 파싱 + 결정 정규화
- 수정 시 피드백을 Worker 프롬프트에 주입

### 7. Memory System (`memory.ts`)

PRD v2.0 기반 인지 메모리 시스템.

- **Storage**: LanceDB (벡터 DB) + Xenova/multilingual-e5-base (768D 로컬 임베딩)
- **Types**: belief, strategy, user_model, system_pattern, constraint + 레거시(decision, repomap, journal, fact)
- **Retrieval**: Hybrid Score = 0.55*similarity + 0.20*importance + 0.15*recency + 0.10*frequency
- **Background Cognition**: decay(망각), consolidation(중복 병합), contradiction detection
- **Distillation**: 저장 전 노이즈 필터링 (잡담, 짧은 텍스트, 일회성 감정 제거)

### 8. Project Mapper (`projectMapper.ts`)

Linear 프로젝트명을 로컬 파일시스템 경로로 매핑.

- `~/dev` 하위 디렉토리 스캔
- Levenshtein distance 기반 퍼지 매칭
- 5분 TTL 캐시
- 매핑 실패 시 fallback: 직접 경로 시도 (대소문자 변환)

### 9. Discord Bot (`discord.ts`)

사용자 인터페이스 + 보고 채널.

- 명령어: `!status`, `!run`, `!pair`, `!issues`, `!memory`, `!auto`, `!schedule`, `!decompose` 등
- OpenClaw 스타일 대화 히스토리 (채널별 LRU, 30개 메시지)
- 프로젝트 컨텍스트 자동 감지 (이슈 접두사 → 프로젝트 매핑)
- 허용 유저 ID 기반 접근 제어

### 10. Task Scheduler (`taskScheduler.ts`)

병렬 태스크 큐 관리.

- 우선순위 기반 삽입 정렬
- 프로젝트별 동시 실행 제한 (같은 프로젝트 중복 방지)
- 슬롯 관리: `maxConcurrent` 설정
- 이벤트 기반: `started`, `completed`, `failed`, `slotFreed`

### 11. Planner Agent (`planner.ts`)

큰 이슈를 30분 단위 sub-task로 분해.

- Claude CLI로 분석만 수행 (코드 작성 안 함)
- 키워드 기반 시간 추정 heuristic
- Linear sub-issue 자동 생성

---

## Data Flow

### Issue Processing Flow

```
Linear (Todo/InProgress)
  → getMyIssues()
  → linearIssueToTask()
  → DecisionEngine.heartbeat()
  → [filterExecutable → prioritize → validateScope → taskToWorkflow]
  → resolveProjectPath() via projectMapper
  → PairPipeline.run()
  → [Worker → parse → Reviewer → approve/revise/reject]
  → Linear state update (Done/Blocked)
  → Discord report
```

### Memory Flow

```
작업 완료/실패
  → saveCognitiveMemory('strategy'/'belief', ...)
  → Distillation (noise filter)
  → getEmbedding() via Xenova
  → LanceDB.add()

검색 시:
  → searchMemorySafe(query)
  → getEmbedding(query)
  → LanceDB.vectorSearch()
  → Hybrid scoring (similarity + importance + recency + frequency)
  → Return ranked results
```

---

## Configuration

```yaml
# 핵심 설정 구조 (config.yaml)
discord:        # Bot token, channel ID
linear:         # API key, team ID
github:         # CI 모니터링 repos
agents:         # 에이전트 목록 (name, projectPath, heartbeatInterval)
autonomous:     # 자율 모드 설정
  schedule:     # Cron 표현식
  pairMode:     # Worker/Reviewer 활성화
  defaultRoles: # 역할별 모델/타임아웃
  decomposition:# Planner 설정
```

Zod 스키마로 환경변수 치환(`${VAR}`) + 유효성 검증 수행.

---

## Technology Stack

| Category | Technology |
|----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript (strict mode) |
| Build | tsc → dist/ |
| Agent Execution | Claude CLI (`claude -p`) via child_process.spawn |
| Task Queue | Linear SDK (@linear/sdk) |
| Communication | Discord.js 14 |
| Vector DB | LanceDB + Apache Arrow |
| Embeddings | Xenova/transformers (multilingual-e5-base, 768D) |
| Scheduling | Croner (cron parser) |
| Config Validation | Zod |
| Config Format | YAML |
| Linting | oxlint |
| Testing | Vitest |

---

## Known Issues & Improvement Areas

### ISSUE-1: Linear 프로젝트 → 디렉토리 매핑 불안정

**현재 구현:**
1. `projectMapper.ts`: ~/dev 하위 스캔 + Levenshtein fuzzy matching (≥0.5)
2. `autonomousRunner.ts:resolveProjectPath()`: mapper → 직접경로 → 소문자 경로 순서로 시도
3. `discord.ts`: 하드코딩된 `ISSUE_PREFIX_MAP` (`INT→claude-swarm`, `STONKS→STONKS` 등)

**문제점:**
- `projectMapper`와 `discord.ts`의 매핑 로직이 이중화됨 (두 곳에서 별도 관리)
- `ISSUE_PREFIX_MAP`이 discord.ts에 하드코딩되어 확장 시 코드 수정 필요
- `projectMapper`의 Levenshtein 0.5 임계값이 너무 낮아 오매핑 가능성 존재
- `config.yaml`의 `allowedProjects`가 `~/dev/claude-swarm` 하나뿐 → 멀티프로젝트 시 누락
- `projectAgents` 설정에 `linearProjectId`가 있지만 실제 매핑 로직에서 활용되지 않음

**권장 개선:**
- `config.yaml`에 명시적 매핑 테이블 추가: `{ linearProjectName: localPath }`
- `projectMapper`를 설정 기반으로 전환 (fuzzy matching은 fallback으로만)
- `discord.ts`의 하드코딩 매핑 제거, 공통 모듈로 통합

### ISSUE-2: 에이전트 보고(Reporting) 누수

**현재 구현:**
- `autonomousRunner.ts`에서 `saveCognitiveMemory()` 호출이 5+ 곳에 분산됨:
  - `executeTask()` 성공/실패 시
  - `executeTaskPairMode()` 성공 시
  - `scheduler.on('completed')` 콜백에서
  - `reportExecutionResult()` 내부에서
  - `DecisionEngine.executeTask()` 성공/실패 시
- **중복 저장 발생**: 같은 작업 완료가 2-3번 메모리에 기록될 수 있음

**Memory 누수 패턴:**
1. **무한 성장**: `table.add()`만 하고 `cleanup`이 비효율적
   - `cleanupExpired()`는 만료 레코드를 찾기만 하고 실제 삭제하지 않음 (Line 1243: 로깅만)
   - 배경 작업(`applyMemoryDecay`)에서 decay → archive하지만 레코드 자체는 삭제 안 됨
2. **reviseMemory/markContradiction/reconcileContradiction**: 전체 테이블 재생성 (dropTable → createTable)
   - 10000개 레코드 limit으로 검색 → 메모리 대량 사용
   - 동시 접근 시 race condition 가능
3. **consolidateMemories()**: 마찬가지로 전체 테이블 재생성
4. **임베딩 파이프라인**: Xenova 모델이 GPU 없이 CPU에서 실행 → 메모리 ~500MB 상주
5. **LanceDB 연결**: `db`와 `table`이 모듈 레벨 싱글톤으로 GC 불가

**권장 개선:**
- Memory 저장을 중앙화된 함수로 통합 (현재 5+ 곳에서 분산 호출)
- `cleanupExpired()`에 실제 삭제 로직 구현 (또는 TTL 기반 LanceDB 관리)
- 전체 테이블 재생성 대신 LanceDB의 filter/delete API 사용
- 하루 한 번 `runBackgroundCognition()` 스케줄링 (현재 호출자 없음)
- 메모리 총량 상한선 설정 (현재 10000개 hard limit이 검색에만 적용)

### ISSUE-3: 레거시 코드와 신규 코드 혼재

- `tmux.ts`: README에 tmux 기반 아키텍처 설명이 있으나, 실제로 `spawn` 기반으로 전환됨 (7a9dc51)
- `service.ts:runHeartbeat()`: 여전히 tmux 기반 흐름 사용
- `autonomous mode`와 `legacy heartbeat` 두 실행 경로가 공존
- `models` (레거시) vs `defaultRoles` (신규) 설정 이중화

### ISSUE-4: 에러 처리 불완전

- Worker/Reviewer CLI 실행 시 stderr가 500자로 잘림
- `seenFailures` Set이 1000개 초과 시 전체 초기화 (시간 기반 정리 없음)
- `pairPipeline.ts`의 이벤트 핸들러에서 async 에러가 조용히 무시될 수 있음

---

## File Structure

```
claude-swarm/
├── src/
│   ├── index.ts              # Entry point
│   ├── service.ts            # Main service orchestrator
│   ├── config.ts             # Config loading + Zod validation
│   ├── types.ts              # Shared type definitions
│   │
│   ├── autonomousRunner.ts   # Autonomous execution loop (core)
│   ├── decisionEngine.ts     # Task selection + scope guard
│   ├── taskScheduler.ts      # Parallel task queue
│   ├── pairPipeline.ts       # Worker/Reviewer pipeline
│   │
│   ├── worker.ts             # Claude CLI worker agent
│   ├── reviewer.ts           # Claude CLI reviewer agent
│   ├── tester.ts             # Test execution agent
│   ├── documenter.ts         # Documentation agent
│   ├── planner.ts            # Task decomposition agent
│   │
│   ├── agentPair.ts          # Pair session state management
│   ├── stuckDetector.ts      # Infinite loop detection
│   ├── editParser.ts         # SEARCH/REPLACE block parser
│   ├── gitTracker.ts         # Git diff-based change tracking
│   ├── projectMapper.ts      # Linear → local path mapping
│   │
│   ├── discord.ts            # Discord bot + commands
│   ├── linear.ts             # Linear SDK integration
│   ├── memory.ts             # Cognitive memory (LanceDB + embeddings)
│   │
│   ├── scheduler.ts          # Cron job scheduler
│   ├── tmux.ts               # Legacy tmux management
│   ├── github.ts             # GitHub CI monitoring
│   ├── web.ts                # Web dashboard
│   ├── timeWindow.ts         # Trading hours restriction
│   ├── workflow.ts           # DAG workflow engine
│   ├── workflowExecutor.ts   # Workflow step executor
│   ├── taskParser.ts         # Issue → subtask decomposition
│   ├── codex.ts              # Codex integration
│   ├── dev.ts                # Dev utilities
│   ├── pairMetrics.ts        # Pair mode statistics
│   └── pairWebhook.ts        # Webhook notifications
│
├── config.yaml               # Main configuration
├── config.example.yaml       # Config template
├── docker-compose.yml        # Docker deployment
├── Dockerfile                # Container build
├── package.json              # Dependencies
├── tsconfig.json             # TypeScript config
└── .claude/                  # Claude Code agent configs
    ├── agents/               # Specialized agent prompts
    └── settings.json         # MCP + permission settings
```

---

## Version History

| Commit | Description |
|--------|-------------|
| 60ff249 | Worker/Reviewer 페어 모드 시스템 구현 |
| 7a9dc51 | tmux pane → spawn 기반 실행 전환 |
| f3c4571 | Ollama → Xenova/transformers 로컬 임베딩 전환 |
| ca358be | LanceDB expiresAt 타입 추론 에러 수정 |
| a201cfa | autoExecute 활성화, 30분 스케줄 |
| 81d81a1 | Backlog 제외 (Todo/InProgress/Review만 자율 처리) |
| 877cba2 | Decision Engine + scope constraints |
| 2433e7c | DAG 기반 workflow engine |
| b11c6d6 | 시간 윈도우 (장중 작업 제한) |

---

*Last updated: 2026-02-10*
