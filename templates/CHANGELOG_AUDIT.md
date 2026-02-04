---
description: 릴리즈 전 changelog 감사
trigger: /changelog
---

# Changelog Audit

릴리즈 전 모든 커밋에 대한 changelog 항목 감사.

## Process

### 1. 마지막 릴리즈 태그 찾기

```bash
git tag --sort=-version:refname | head -1
```

### 2. 해당 태그 이후 모든 커밋 나열

```bash
git log <tag>..HEAD --oneline
```

### 3. CHANGELOG.md의 [Unreleased] 섹션 확인

### 4. 각 커밋에 대해 확인

**스킵 대상:**
- changelog 업데이트
- 문서만 변경
- 릴리즈 관련 housekeeping

**확인 사항:**
- `git show <hash> --stat`로 영향받는 영역 파악
- 해당 영역의 changelog 항목 존재 여부
- 외부 기여(PR)의 경우 포맷 확인: `설명 ([#N](url) by [@user](url))`

### 5. 보고서 작성

- 누락된 항목이 있는 커밋 목록
- 추가 필요한 항목 직접 추가

## Changelog Format

### 섹션 순서

```markdown
### Breaking Changes
API 변경으로 마이그레이션 필요

### Added
새 기능

### Changed
기존 기능 변경

### Fixed
버그 수정

### Removed
제거된 기능
```

### Attribution 형식

**내부:**
```markdown
- Fixed foo ([#123](https://github.com/owner/repo/issues/123))
```

**외부:**
```markdown
- Added bar ([#456](https://github.com/owner/repo/pull/456) by [@user](https://github.com/user))
```
