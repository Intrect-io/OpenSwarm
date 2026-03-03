# PR Auto-Fix with Retry Loop

OpenSwarm의 PR Processor는 GitHub PR의 CI 실패를 자동으로 감지하고 수정하며, CI가 통과할 때까지 재시도하는 기능을 제공합니다.

## 기능 개요

### 1. 자동 충돌 감지
- PR에 merge conflict가 있는지 자동 확인
- 충돌이 있으면 자동 수정을 건너뛰고 사용자에게 알림

### 2. CI 실패 자동 수정
- Worker-Reviewer 파이프라인으로 CI 에러 분석 및 수정
- 타입 에러, 린트 에러, 테스트 실패, 빌드 에러 등 자동 수정

### 3. CI 상태 모니터링
- 수정 후 CI 체크가 완료될 때까지 대기 (폴링)
- 실시간으로 CI 상태 추적

### 4. 자동 재시도 루프
- CI가 실패하면 자동으로 재시도
- 최대 재시도 횟수까지 반복 (기본 3회)
- 각 재시도마다 최신 에러 로그 분석

## 설정 방법

`config.yaml`에 다음 설정을 추가:

```yaml
prProcessor:
  enabled: true            # PR Processor 활성화
  schedule: "*/30 * * * *" # 30분마다 실행 (cron)
  cooldownHours: 6         # PR 처리 후 대기 시간 (시간)
  maxIterations: 5         # Worker-Reviewer 최대 이터레이션
  maxRetries: 3            # PR당 최대 재시도 횟수
  ciTimeoutMs: 600000      # CI 완료 대기 타임아웃 (10분)
  ciPollIntervalMs: 30000  # CI 상태 폴링 간격 (30초)
```

### 설정 옵션 설명

- **enabled**: PR Processor 활성화 여부
- **schedule**: PR 체크 스케줄 (cron 표현식)
- **cooldownHours**: 같은 PR을 다시 처리하기 전 대기 시간
- **maxIterations**: Worker-Reviewer 파이프라인의 최대 이터레이션 횟수
- **maxRetries**: PR당 최대 재시도 횟수 (기본 3회)
- **ciTimeoutMs**: CI 완료 대기 최대 시간 (밀리초)
- **ciPollIntervalMs**: CI 상태 확인 간격 (밀리초)

## 작동 흐름

```
1. PR 목록 조회
   ↓
2. CI 실패가 있는 PR 필터링
   ↓
3. 충돌 체크
   ├─ 충돌 있음 → 알림 후 건너뛰기
   └─ 충돌 없음 → 계속
   ↓
4. 재시도 루프 시작 (최대 maxRetries회)
   ↓
   ├─ a. 최신 PR 컨텍스트 조회 (에러 로그 포함)
   ├─ b. Worker-Reviewer 파이프라인 실행
   ├─ c. 파이프라인 성공?
   │     ├─ 실패 → 재시도
   │     └─ 성공 → git push
   ├─ d. CI 완료 대기 (폴링)
   └─ e. CI 결과 확인
         ├─ 성공 → 완료 (PR에 성공 코멘트)
         ├─ 실패 → 재시도
         └─ 타임아웃 → 실패 처리
   ↓
5. 최종 결과를 PR에 코멘트로 알림
```

## 사용 예시

### 성공 케이스
```
[PRProcessor] Processing Intrect-io/STONKS#123: "Add new feature"
[PRProcessor] Intrect-io/STONKS#123: Attempt 1/3
[PRProcessor] Intrect-io/STONKS#123: Pipeline succeeded, pushing changes...
[PRProcessor] Intrect-io/STONKS#123: Waiting for CI checks...
[PRProcessor] Intrect-io/STONKS#123: CI pending (30s elapsed)...
[PRProcessor] Intrect-io/STONKS#123: CI pending (60s elapsed)...
[PRProcessor] Intrect-io/STONKS#123: SUCCESS after 1 attempt(s)
```

PR에 다음 코멘트가 추가됩니다:
```markdown
## ✅ Auto-fix completed - CI passing

**Summary:** Fixed type errors and lint issues
**Files changed:** src/api/handler.ts, src/types.ts
**Total attempts:** 1
**Total iterations:** 3
```

### 재시도 케이스
```
[PRProcessor] Processing Intrect-io/STONKS#124: "Fix bug"
[PRProcessor] Intrect-io/STONKS#124: Attempt 1/3
[PRProcessor] Intrect-io/STONKS#124: Pipeline succeeded, pushing changes...
[PRProcessor] Intrect-io/STONKS#124: Waiting for CI checks...
[PRProcessor] Intrect-io/STONKS#124: CI checks failed: Build, Test
[PRProcessor] Intrect-io/STONKS#124: Retrying due to CI failure...
[PRProcessor] Intrect-io/STONKS#124: Attempt 2/3
[PRProcessor] Intrect-io/STONKS#124: Pipeline succeeded, pushing changes...
[PRProcessor] Intrect-io/STONKS#124: Waiting for CI checks...
[PRProcessor] Intrect-io/STONKS#124: SUCCESS after 2 attempt(s)
```

### 실패 케이스
```
[PRProcessor] Processing Intrect-io/STONKS#125: "Complex refactor"
[PRProcessor] Intrect-io/STONKS#125: Attempt 1/3
[PRProcessor] Intrect-io/STONKS#125: Pipeline succeeded, pushing changes...
[PRProcessor] Intrect-io/STONKS#125: CI checks failed: Integration tests
[PRProcessor] Intrect-io/STONKS#125: Retrying...
[PRProcessor] Intrect-io/STONKS#125: Attempt 2/3
[PRProcessor] Intrect-io/STONKS#125: Pipeline succeeded, pushing changes...
[PRProcessor] Intrect-io/STONKS#125: CI checks failed: Integration tests
[PRProcessor] Intrect-io/STONKS#125: Retrying...
[PRProcessor] Intrect-io/STONKS#125: Attempt 3/3
[PRProcessor] Intrect-io/STONKS#125: Pipeline succeeded, pushing changes...
[PRProcessor] Intrect-io/STONKS#125: CI checks failed: Integration tests
[PRProcessor] Intrect-io/STONKS#125: FAILED after 3 attempt(s)
```

PR에 다음 코멘트가 추가됩니다:
```markdown
## ❌ Auto-fix failed after 3 attempt(s)

**Total iterations:** 15
**Last error:** CI checks failed: Integration tests

Manual intervention required.
```

## 제한사항

1. **충돌 해결 불가**: Merge conflict가 있는 PR은 자동 수정하지 않습니다.
2. **복잡한 CI 실패**: Integration test 실패 등 복잡한 문제는 자동 수정이 어려울 수 있습니다.
3. **타임아웃**: CI가 너무 오래 걸리면 타임아웃됩니다.

## 주의사항

- `maxRetries`를 너무 크게 설정하면 불필요한 재시도로 리소스를 낭비할 수 있습니다.
- `ciTimeoutMs`는 프로젝트의 평균 CI 시간보다 충분히 크게 설정하세요.
- `cooldownHours`를 설정하여 같은 PR을 너무 자주 처리하지 않도록 합니다.

## 로그 및 모니터링

- Discord 채널에 PR 처리 결과가 실시간으로 보고됩니다.
- 각 PR 처리 상태는 `~/.openswarm/pr-state.json`에 저장됩니다.
- 로그는 콘솔 출력으로 확인할 수 있습니다.

## 트러블슈팅

### PR Processor가 시작되지 않음
- `config.yaml`에서 `prProcessor.enabled: true`로 설정되어 있는지 확인
- GitHub repos가 올바르게 설정되어 있는지 확인

### CI 상태를 확인할 수 없음
- `gh` CLI가 설치되어 있고, 인증이 완료되었는지 확인
- GitHub repository에 접근 권한이 있는지 확인

### 재시도가 너무 많음
- `maxRetries`를 줄이거나 `cooldownHours`를 늘려보세요
- CI 실패 원인이 코드 이슈가 아닌 인프라 문제일 수 있습니다

## API

### GitHub API Functions

새로 추가된 GitHub API 함수들:

```typescript
// PR 충돌 체크
async function checkPRConflicts(repo: string, prNumber: number): Promise<boolean>

// CI 상태 확인
async function checkPRCIStatus(repo: string, prNumber: number): Promise<CIStatus>

// CI 완료 대기
async function waitForCICompletion(
  repo: string,
  prNumber: number,
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    onProgress?: (status: CIStatus, elapsed: number) => void;
  }
): Promise<CIStatus>
```

### Types

```typescript
type CIStatus =
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failure'; failedChecks: { name: string; conclusion: string }[] }
```

## 확장 가능성

향후 개선 가능한 기능:

1. **선택적 재시도**: 특정 종류의 CI 실패만 재시도
2. **병렬 PR 처리**: 여러 PR을 동시에 처리
3. **우선순위**: Critical 라벨이 있는 PR을 먼저 처리
4. **학습 기능**: 이전 수정 패턴을 학습하여 성공률 향상
