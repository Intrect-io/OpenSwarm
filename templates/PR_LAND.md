---
description: PR 랜딩 (리뷰 + merge 워크플로)
trigger: /land <pr_number_or_url>
---

# PR Land

PR: $ARGUMENTS

## Goal

PR 리뷰 후 merge까지 완료.

## Process

### Phase 1: Review (PR_REVIEW.md와 동일)

1-8단계 리뷰 수행 후 READY 판정 시 Phase 2 진행.

### Phase 2: Land

1. **main에서 임시 브랜치 생성**
   ```sh
   git checkout main
   git pull
   git checkout -b land-pr-<number>
   ```

2. **PR 브랜치 가져오기**
   - 깔끔한 커밋 히스토리면 **rebase** 선호
   - 복잡하면 **squash merge**
   ```sh
   gh pr checkout <PR>
   git rebase main  # 또는 squash
   ```

3. **필요한 수정 적용**
   - 리뷰에서 발견한 이슈 수정
   - 테스트 실행 확인

4. **Changelog 추가**
   - PR 번호 포함
   - 외부 contributor면 감사 표시
   ```
   - Fix something ([#123](url) by [@user](url))
   ```

5. **전체 게이트 실행**
   ```sh
   npm run build && npm run lint && npm run test
   ```

6. **커밋**
   - squash 시 원 author를 co-contributor로
   ```
   Co-Authored-By: User <user@email.com>
   ```

7. **main으로 merge**
   ```sh
   git checkout main
   git merge land-pr-<number>
   git branch -d land-pr-<number>
   git push
   ```

8. **PR 코멘트 남기기**
   - 무엇을 했는지 설명
   - commit SHA 포함

## Rules

- READY 판정 전에는 merge 금지
- contributor가 git graph에 남아야 함
- 작업 완료 후 반드시 main 브랜치로 복귀
