# Cron Jobs (스케줄러)

> **Cron vs Heartbeat?** [CRON_VS_HEARTBEAT.md](./CRON_VS_HEARTBEAT.md) 참조

Cron은 내장 스케줄러. job을 저장하고, 적절한 시간에 에이전트를 깨우고, 선택적으로 출력을 채팅으로 전달.

_"매일 아침 실행"_ 또는 _"20분 후 에이전트 깨우기"_ 원하면 cron이 메커니즘.

## TL;DR

- Cron은 **서비스 내부**에서 실행 (모델 내부 아님)
- Job은 재시작해도 스케줄 유지되도록 저장
- 두 가지 실행 스타일:
  - **Main session**: 시스템 이벤트 큐잉, 다음 heartbeat에 실행
  - **Isolated**: 전용 에이전트 턴 실행, 선택적으로 출력 전달
- Wakeup이 일급: "지금 깨우기" vs "다음 heartbeat"

## Quick Start

```typescript
// 원샷 리마인더
await cronService.addJob({
  name: "Reminder",
  schedule: { kind: "at", atMs: Date.now() + 20 * 60 * 1000 },
  sessionTarget: "main",
  wakeMode: "now",
  payload: { kind: "systemEvent", text: "체크할 것: 문서 드래프트" },
  deleteAfterRun: true,
});

// 반복 isolated job
await cronService.addJob({
  name: "Morning brief",
  schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Seoul" },
  sessionTarget: "isolated",
  payload: {
    kind: "agentTurn",
    message: "오버나이트 업데이트 요약해줘.",
    deliver: true,
    channel: "discord",
  },
});
```

## Concepts

### Schedules

세 가지 스케줄 종류:

- `at`: 원샷 타임스탬프 (epoch ms). ISO 8601 받아서 UTC로 변환.
- `every`: 고정 간격 (ms).
- `cron`: 5-필드 cron 표현식 + 선택적 IANA 타임존.

```typescript
// 예시
{ kind: "at", atMs: 1738262400000 }
{ kind: "every", everyMs: 3600000 }  // 1시간마다
{ kind: "cron", expr: "0 7 * * *", tz: "Asia/Seoul" }  // 매일 7시
```

### Main vs Isolated Execution

#### Main session jobs (system events)

메인 job은 시스템 이벤트를 큐잉하고 선택적으로 heartbeat runner 깨움.
`payload.kind = "systemEvent"` 사용 필수.

- `wakeMode: "next-heartbeat"` (기본): 다음 예정된 heartbeat 대기
- `wakeMode: "now"`: 즉시 heartbeat 실행 트리거

정상 heartbeat 프롬프트 + 메인 세션 컨텍스트 원할 때 최적.

#### Isolated jobs (dedicated cron sessions)

Isolated job은 `cron:<jobId>` 세션에서 전용 에이전트 턴 실행.

주요 동작:
- 프롬프트에 `[cron:<jobId> <job name>]` 접두사로 추적 가능
- 각 실행은 **새 세션 id** 시작 (이전 대화 이월 없음)
- 메인 세션에 요약 게시 (`Cron` 접두사, 설정 가능)
- `wakeMode: "now"`면 요약 게시 후 즉시 heartbeat 트리거
- `payload.deliver: true`면 출력이 채널로 전달; 아니면 내부 유지

메인 채팅 히스토리 스팸 안 하는 노이즈, 빈번, "백그라운드 잡"에 isolated job 사용.

### Payload Shapes

두 가지 payload 종류:

```typescript
// Main session용
{ kind: "systemEvent", text: "다음 heartbeat: 캘린더 체크." }

// Isolated session용
{
  kind: "agentTurn",
  message: "오늘 받은편지함 + 캘린더 요약.",
  model: "opus",  // 선택: 모델 오버라이드
  thinking: "high",  // 선택: thinking 레벨
  deliver: true,
  channel: "discord",
  to: "channel:1234567890",
}
```

### Delivery (채널 + 타겟)

Isolated job은 출력을 채널로 전달 가능:

- `channel`: `discord` / `slack` / `telegram` / `whatsapp` / `last`
- `to`: 채널별 수신자 타겟

```typescript
// Discord 예시
{ channel: "discord", to: "channel:1398253695174709319" }

// Telegram 토픽 예시
{ channel: "telegram", to: "-1001234567890:topic:123" }
```

## Decision Flowchart

```
태스크가 정확한 시간에 실행되어야 하나?
  YES -> cron 사용
  NO  -> 계속...

태스크가 메인 세션과 격리 필요한가?
  YES -> cron (isolated) 사용
  NO  -> 계속...

이 태스크를 다른 주기적 체크와 배치 가능한가?
  YES -> heartbeat 사용 (HEARTBEAT.md에 추가)
  NO  -> cron 사용

원샷 리마인더인가?
  YES -> cron with --at 사용
  NO  -> 계속...

다른 모델이나 thinking 레벨 필요한가?
  YES -> cron (isolated) with model/thinking 사용
  NO  -> heartbeat 사용
```

## Cost Considerations

| 메커니즘 | 비용 프로필 |
|---------|------------|
| Heartbeat | N분마다 한 턴; HEARTBEAT.md 크기에 비례 |
| Cron (main) | 다음 heartbeat에 이벤트 추가 (isolated 턴 없음) |
| Cron (isolated) | job당 전체 에이전트 턴; 저렴한 모델 사용 가능 |

**팁**:
- `HEARTBEAT.md`를 작게 유지해서 토큰 오버헤드 최소화
- 여러 cron job 대신 비슷한 체크를 heartbeat에 배치
- 루틴 태스크에 저렴한 모델로 isolated cron 사용
