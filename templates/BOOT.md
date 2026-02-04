---
description: 시작 시 실행 체크리스트
usage: 서비스 시작 시 자동 실행할 짧은 지시
---

# BOOT.md

서비스 시작 시 실행할 짧고 명시적인 지시 추가.

## Example

```markdown
# Boot Checklist

1. git pull로 최신 코드 동기화
2. npm install로 의존성 확인
3. 환경 변수 로드 확인
4. 서비스 상태 Discord에 보고
```

## Rules

- 짧게 유지 (토큰 절약)
- 메시지 보내야 하면 message tool 사용 후 NO_REPLY로 답
- 외부 액션은 승인된 것만
