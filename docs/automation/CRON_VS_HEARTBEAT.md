# Cron vs Heartbeat: When to Use Each

heartbeat와 cron job 둘 다 스케줄에 따라 태스크 실행 가능. 이 가이드가 사용 케이스에 맞는 메커니즘 선택 도움.

## Quick Decision Guide

| 사용 케이스 | 권장 | 이유 |
|------------|------|------|
| 30분마다 받은편지함 체크 | Heartbeat | 다른 체크와 배치, 컨텍스트 인식 |
| 매일 9시 정각 리포트 | Cron (isolated) | 정확한 타이밍 필요 |
| 다가오는 이벤트 캘린더 모니터링 | Heartbeat | 주기적 인식에 자연스러운 적합 |
| 주간 심층 분석 | Cron (isolated) | 독립 태스크, 다른 모델 사용 가능 |
| 20분 후 리마인드 | Cron (main, `--at`) | 정확한 타이밍의 원샷 |
| 백그라운드 프로젝트 헬스 체크 | Heartbeat | 기존 사이클에 편승 |

## Heartbeat: Periodic Awareness

Heartbeat는 **메인 세션**에서 정기 간격(기본: 30분)으로 실행. 에이전트가 것들을 체크하고 중요한 것 표면화하도록 설계.

### When to use heartbeat

- **여러 주기적 체크**: 받은편지함, 캘린더, 날씨, 알림, 프로젝트 상태 체크하는 5개 별도 cron job 대신, 단일 heartbeat가 모두 배치 가능.
- **컨텍스트 인식 결정**: 에이전트가 전체 메인 세션 컨텍스트 있어서 긴급한 것 vs 기다릴 수 있는 것 현명하게 결정 가능.
- **대화 연속성**: Heartbeat 실행이 같은 세션 공유해서 최근 대화 기억하고 자연스럽게 팔로업 가능.
- **저오버헤드 모니터링**: 하나의 heartbeat가 많은 작은 폴링 태스크 대체.

### Heartbeat advantages

- **여러 체크 배치**: 한 에이전트 턴이 받은편지함, 캘린더, 알림 함께 검토 가능.
- **API 호출 감소**: 단일 heartbeat가 5개 isolated cron job보다 저렴.
- **컨텍스트 인식**: 에이전트가 뭘 작업 중인지 알고 그에 따라 우선순위 가능.
- **스마트 억제**: 주의 필요 없으면 에이전트가 `HEARTBEAT_OK` 답하고 메시지 전달 안 됨.
- **자연스러운 타이밍**: 큐 로드에 따라 약간 드리프트, 대부분 모니터링에 괜찮음.

### Heartbeat example: HEARTBEAT.md checklist

```md
# Heartbeat checklist

- 긴급 메시지 이메일 체크
- 다음 2시간 이벤트 캘린더 검토
- 백그라운드 태스크 완료되면 결과 요약
- 8시간 이상 유휴면 간단한 체크인 보내기
```

에이전트가 각 heartbeat에 이거 읽고 한 턴에 모든 항목 처리.

## Cron: Precise Scheduling

Cron job은 **정확한 시간**에 실행되고 메인 컨텍스트 영향 없이 isolated 세션에서 실행 가능.

### When to use cron

- **정확한 타이밍 필요**: "매주 월요일 9시에 보내기" ("9시쯤 언젠가" 아님)
- **독립 태스크**: 대화 컨텍스트 필요 없는 태스크.
- **다른 모델/thinking**: 더 강력한 모델 필요한 무거운 분석.
- **원샷 리마인더**: `--at`으로 "20분 후 리마인드"
- **노이즈/빈번 태스크**: 메인 세션 히스토리 어지럽힐 태스크.
- **외부 트리거**: 에이전트가 활성인지와 관계없이 독립적으로 실행해야 하는 태스크.

### Cron advantages

- **정확한 타이밍**: 타임존 지원 5-필드 cron 표현식.
- **세션 격리**: 메인 히스토리 오염 없이 `cron:<jobId>`에서 실행.
- **모델 오버라이드**: job별로 저렴하거나 강력한 모델 사용.
- **전달 제어**: 채널로 직접 전달 가능; 기본으로 여전히 메인에 요약 게시 (설정 가능).
- **에이전트 컨텍스트 불필요**: 메인 세션 유휴거나 압축되어도 실행.
- **원샷 지원**: `--at`으로 정확한 미래 타임스탬프.

### Cron example: Daily morning briefing

```typescript
{
  name: "Morning briefing",
  schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Seoul" },
  sessionTarget: "isolated",
  payload: {
    kind: "agentTurn",
    message: "오늘 브리핑 생성: 날씨, 캘린더, 주요 이메일, 뉴스 요약.",
    model: "opus",
    deliver: true,
    channel: "discord",
  },
}
```

서울 시간 정확히 7시에 실행, 품질 위해 Opus 사용, Discord로 직접 전달.

## Combining Both

가장 효율적인 셋업은 **둘 다** 사용:

1. **Heartbeat**가 루틴 모니터링 (받은편지함, 캘린더, 알림) 30분마다 배치 턴으로 처리.
2. **Cron**이 정확한 스케줄 (일간 리포트, 주간 리뷰)와 원샷 리마인더 처리.

### Example: Efficient automation setup

**HEARTBEAT.md** (30분마다 체크):

```md
# Heartbeat checklist

- 긴급 이메일 스캔
- 다음 2시간 이벤트 캘린더 체크
- 대기 중인 태스크 검토
- 8시간 이상 조용하면 가벼운 체크인
```

**Cron jobs** (정확한 타이밍):

```typescript
// 7시 일간 모닝 브리핑
{ name: "Morning brief", schedule: { kind: "cron", expr: "0 7 * * *" }, ... }

// 월요일 9시 주간 프로젝트 리뷰
{ name: "Weekly review", schedule: { kind: "cron", expr: "0 9 * * 1" }, model: "opus", ... }

// 원샷 리마인더
{ name: "Call back", schedule: { kind: "at", atMs: Date.now() + 2*60*60*1000 }, ... }
```

## Main Session vs Isolated Session

|  | Heartbeat | Cron (main) | Cron (isolated) |
|--|-----------|-------------|-----------------|
| Session | Main | Main (시스템 이벤트 경유) | `cron:<jobId>` |
| History | 공유 | 공유 | 매 실행 새로 |
| Context | 전체 | 전체 | 없음 (클린 시작) |
| Model | 메인 세션 모델 | 메인 세션 모델 | 오버라이드 가능 |
| Output | `HEARTBEAT_OK` 아니면 전달 | Heartbeat 프롬프트 + 이벤트 | 메인에 요약 게시 |

## Cost Considerations

| 메커니즘 | 비용 프로필 |
|---------|------------|
| Heartbeat | N분마다 한 턴; HEARTBEAT.md 크기에 비례 |
| Cron (main) | 다음 heartbeat에 이벤트 추가 (isolated 턴 없음) |
| Cron (isolated) | job당 전체 에이전트 턴; 저렴한 모델 사용 가능 |

**팁**:
- `HEARTBEAT.md` 작게 유지해서 토큰 오버헤드 최소화.
- 여러 cron job 대신 비슷한 체크를 heartbeat에 배치.
- 루틴 태스크에 저렴한 모델로 isolated cron 사용.
