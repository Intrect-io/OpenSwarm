# OpenSwarm 🤖

> Autonomous Claude Code agents orchestrator with Discord control and Linear memory

여러 Claude Code 인스턴스를 자율적으로 운영하고, Discord로 모니터링/제어하며, Linear를 장기 메모리로 활용하는 오케스트레이터.

## 개념

```
┌─────────────────────────────────────────────────────────────┐
│                         Linear                               │
│              (장기 메모리 - 이슈 + 코멘트)                    │
└─────────────────────────────────────────────────────────────┘
                          ↑ ↓
┌─────────────────────────────────────────────────────────────┐
│                    OpenSwarm                                   │
│  ┌─────────┐    ┌──────────┐    ┌──────────────┐           │
│  │  Timer  │───→│  Linear  │←──→│   Discord    │           │
│  │(heartbeat)   │   SDK    │    │   Bot        │           │
│  └─────────┘    └──────────┘    └──────────────┘           │
│       │                               ↑                      │
│       ↓                               │                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              tmux send-keys                          │   │
│  └─────────────────────────────────────────────────────┘   │
│       │              │              │                        │
│       ↓              ↓              ↓                        │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐                   │
│  │project-a│   │project-b│   │project-c│                   │
│  │ claude  │   │ claude  │   │ claude  │                   │
│  └─────────┘   └─────────┘   └─────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

## 설치

```bash
cd ~/dev/OpenSwarm
pnpm install
```

## 설정

```bash
# config.json 생성
cp config.example.json config.json
# 편집하여 토큰/ID 입력

# 또는 환경 변수
export DISCORD_TOKEN="..."
export DISCORD_CHANNEL_ID="..."
export LINEAR_API_KEY="..."
export LINEAR_TEAM_ID="..."
```

## 실행

```bash
# 개발 모드
pnpm dev

# 프로덕션
pnpm build && pnpm start

# 백그라운드 실행
nohup pnpm start > swarm.log 2>&1 &
```

## 각 프로젝트 설정

각 프로젝트 루트에 `HEARTBEAT.md` 추가:

```bash
cp templates/HEARTBEAT.md ~/dev/your-project/
```

## Discord 명령어

| 명령어 | 설명 |
|--------|------|
| `!status [session]` | 에이전트 상태 확인 |
| `!list` | 활성 tmux 세션 목록 |
| `!run <session> "<task>"` | 특정 작업 실행 |
| `!pause <session>` | 자율 작업 일시 중지 |
| `!resume <session>` | 자율 작업 재개 |
| `!issues [session]` | Linear 이슈 목록 |
| `!log <session> [lines]` | 최근 출력 확인 |
| `!help` | 도움말 |

## Linear 활용

- **Backlog**: 할 일 목록 (에이전트가 자동으로 픽업)
- **In Progress**: 현재 작업 중 (에이전트당 1개)
- **Blocked**: 막힌 작업 (사용자 개입 필요)
- **Done**: 완료된 작업 (히스토리)

이슈 코멘트 = 장기 메모리:
- 에이전트가 진행상황 자동 기록
- 다음 세션에서 코멘트 읽고 컨텍스트 복원

## 라이선스

MIT
