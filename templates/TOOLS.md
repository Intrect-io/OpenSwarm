---
description: 로컬 도구/환경 설정 노트
usage: 에이전트별 환경 고유 정보 기록
---

# TOOLS.md - Local Notes

스킬은 도구가 _어떻게_ 작동하는지 정의. 이 파일은 _네_ 구체적인 것 — 네 셋업에 고유한 것들.

## What Goes Here

이런 것들:

- 카메라 이름과 위치
- SSH 호스트와 별칭
- TTS 선호 음성
- 스피커/방 이름
- 디바이스 별명
- 환경 특화 모든 것

## Examples

```markdown
### Cameras

- living-room → 메인 공간, 180° 광각
- front-door → 입구, 모션 트리거

### SSH

- home-server → 192.168.1.100, user: admin
- dev-box → unohee@192.168.1.50

### TTS

- 선호 음성: "Nova" (따뜻함, 약간 British)
- 기본 스피커: Kitchen HomePod

### MCP Servers

- pykis-local: 한국투자증권 API
- pykiwoom: 키움증권 API
- playwright: 브라우저 자동화
```

## Why Separate?

스킬은 공유됨. 네 셋업은 네 것. 분리해두면 네 노트 잃지 않고 스킬 업데이트 가능, 인프라 새지 않고 스킬 공유 가능.

---

일 하는 데 도움 되는 거 추가해. 네 치트시트.
