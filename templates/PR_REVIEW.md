---
description: PR 리뷰 (merge 없이 검토만)
trigger: /review <pr_number_or_url>
---

# PR Review

PR: $ARGUMENTS

## Goal

철저한 리뷰와 명확한 권고 (READY / NEEDS WORK).
**merge, push, 코드 변경 금지** - 리뷰만 수행.

## Process

### 1. PR 메타데이터 확인

```sh
gh pr view <PR> --json number,title,state,isDraft,author,baseRefName,headRefName,url,body,files,additions,deletions --jq '{number,title,url,state,isDraft,author:.author.login,base:.baseRefName,head:.headRefName,additions,deletions,files:.files|length}'
```

### 2. PR 설명 분석
- 목표, 범위, "왜 지금?" 이유 요약
- 누락된 컨텍스트 지적: 동기, 대안 검토, 롤아웃/호환성, 리스크

### 3. Diff 철저히 읽기

```sh
gh pr diff <PR>
```

### 4. 변경 필요성/가치 검증
- 어떤 문제를 해결하는가?
- 가장 작은 합리적 수정인가?
- 미미한 이익을 위해 복잡성을 도입하는가?
- 문서나 릴리즈 노트가 필요한 동작 변경인가?

### 5. 구현 품질 평가
- **정확성**: edge cases, 에러 처리, null/undefined, 동시성
- **설계**: 적절한 추상화인가? over/under-engineered?
- **성능**: hot paths, allocations, N+1, 캐싱
- **보안**: authz/authn, 입력 검증, secrets, PII 로깅
- **하위 호환성**: public API, config, migrations
- **스타일 일관성**: formatting, naming, 기존 패턴

### 6. 테스트 & 검증
- 어떤 테스트로 커버되는가?
- 버그 수정/시나리오에 대한 회귀 테스트가 있는가?
- 누락된 테스트 케이스 지적
- 중요 동작을 실제로 assert하는가? (snapshot/happy path만 아닌지)

### 7. 후속 리팩토링/정리 제안
- merge 전 단순화할 코드?
- 지금 해결 vs 티켓으로 남길 TODO?
- deprecation, docs, types, lint rules 조정?

### 8. 핵심 질문
- 우리가 follow-up으로 수정 가능한가, contributor 업데이트 필요한가?
- blocking concerns (merge 전 필수 수정)?
- PR이 land 준비되었는가?

## Output Format

### A) TL;DR 권고
- `READY FOR MERGE` | `NEEDS WORK` | `NEEDS DISCUSSION`
- 1-3문장 근거

### B) 변경 사항
- diff/동작 변경 요약 bullet

### C) 좋은 점
- 정확성, 단순성, 테스트, 문서, 편의성 등

### D) 우려/질문 (actionable)
- 번호 매긴 목록
- 각 항목 표시:
  - **BLOCKER** (merge 전 필수)
  - **IMPORTANT** (merge 전 권장)
  - **NIT** (선택)
- 파일/영역 지적 + 구체적 수정안 제시

### E) 테스트
- 존재하는 것
- 누락된 것 (구체적 시나리오)

### F) Follow-ups (optional)
- non-blocking 리팩토링/티켓

### G) PR 코멘트 제안 (optional)
- "PR 코멘트 초안 작성할까요?"
- 요청 시 복붙 가능한 코멘트 제공

## Rules

- **리뷰 전용**: `gh pr merge` 금지, 브랜치 push 금지, 코드 편집 금지
- 명확하지 않으면 추측 대신 질문
