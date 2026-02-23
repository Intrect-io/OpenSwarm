PRD — Persistent Cognitive Memory for OpenSwarm
0. Document Status

Owner: OpenSwarm Runtime

Priority: Critical (architecture-defining)

Risk Level: High leverage / High failure cost

1. Objective

OpenSwarm이 세션 기반 에이전트 → 지속적 인지 상태를 가진 시스템으로 전환되도록
장기 메모리 계층(Persistent Cognitive Memory Layer)을 설계한다.

이 프로젝트의 목적은 단순 retrieval 향상이 아니다.

👉 시간에 따라 수정되는 belief 구조 구축

2. Non-Goals (매우 중요)

다음 접근은 금지한다.

❌ Raw conversation → VectorDB dump

노이즈 폭증 + reasoning 오염 발생.

❌ Infinite memory

망각 없는 인지는 장기적으로 붕괴한다.

❌ Similarity-only retrieval

importance / recency 없는 시스템은 결국 잘못된 기억을 참조한다.

3. System Overview
Architecture

Conversation Stream
↓
Semantic Distillation Engine
↓
Memory Object Generator
↓
Memory Store (ChromaDB + metadata)
↓
Hybrid Retrieval Layer
↓
Agent Reasoning

핵심 철학:

Memory is compressed inference.

4. Core Design Principles
✅ Sparse Memory

저장 기준을 높게 유지

추론을 바꾸는 정보만 저장

✅ Memory Must Evolve

append-only 금지.

모든 belief는 revision 가능해야 한다.

✅ Time-aware Cognition

에이전트에게 시간 감각 부여.

✅ Background Cognition

에이전트는 idle 상태에서도 메모리를 정리해야 한다.

5. Memory Object Schema
Base Schema (Mandatory)
{
  "id": "uuid",
  "type": "belief | strategy | user_model | system_pattern | constraint",
  "content": "normalized semantic statement",
  "embedding": "...",
  "importance": 0-1,
  "confidence": 0-1,
  "created_at": "timestamp",
  "last_updated": "timestamp",
  "last_accessed": "timestamp",
  "revision_count": 0,
  "decay": 0-1
}

Strongly Recommended Extensions
{
  "contradicts": ["memory_id"],
  "supports": ["memory_id"],
  "derived_from": ["conversation_id"],
  "stability": "low | medium | high"
}


👉 이후 belief graph로 확장 가능.

6. Semantic Distillation Engine
역할

대화를 추론 가능한 단위로 압축한다.

Distillation Rules
Extract ONLY if:

행동을 바꾸는 정보

반복적으로 등장한 패턴

검증된 전략

사용자 고정 성향

시스템 설계 철학

NEVER store:

잡담

일회성 감정

폐기된 가설

컨텍스트 의존 질문

Distillation Quality Test

이 메모리가 사라지면 미래 추론 성능이 저하되는가?

NO → 저장 금지.

Example

GOOD:

User prefers beta-neutral exposure over directional trades.

BAD:

User seemed excited about today's market.

Suggested Distillation Prompt (internal LLM)
Extract only high-signal cognitive artifacts.
If this memory disappears, would future reasoning degrade?
If NO → discard.

7. Importance Scoring

LLM 기반 평가 추천.

Base Importance Guide
Memory Type	Score
constraint	0.9
user_model	0.85
strategy	0.8
belief	0.7
temporary insight	0.4
Adjustments

Increase when:

반복 등장

실전에서 검증됨

Decrease when:

오래됨

모순 발생

8. Retrieval Model (Critical)

Similarity-only 금지.

Hybrid Score
final_score =
    0.55 * semantic_similarity +
    0.20 * importance +
    0.15 * recency +
    0.10 * access_frequency

Top-K

👉 권장: 5 ~ 12

컨텍스트 과주입은 reasoning 품질을 떨어뜨린다.

9. Memory Revision Loop (VERY CRITICAL)

OpenSwarm 지능을 결정하는 핵심 모듈.

Example Evolution

belief_v1
"CNN ineffective for price data"

belief_v2
"CNN effective after volatility normalization"

Required Behavior

기존 belief 수정

revision_count 증가

stability 재평가

importance 재조정

append-only 시스템은 결국 cognitive landfill가 된다.

10. Background Cognitive Tasks (Heartbeat Workers)

권장 실행 주기:

👉 6–12시간

✔ Memory Consolidation

중복 merge

stale memory decay 증가

✔ Contradiction Detection

semantic conflict 탐지

belief reconciliation 수행

✔ Memory Decay

예시:

decay += 0.03 weekly if not accessed


threshold 초과 시 archive.

망각은 기능이다.

11. Storage Strategy

ChromaDB 사용 가능.

하지만 반드시 metadata 인덱싱 강화:

필수 인덱스:

timestamp

importance

memory type

Future Upgrade (권장)

👉 Vector + Graph hybrid

예:

pgvector + edges

Neo4j

LanceDB

이 단계로 가면 belief topology가 생긴다.

12. Failure Modes (반드시 이해할 것)
⚠ Over-memory

증상:

hallucination anchor 증가

reasoning rigidity

latency 상승

대응:

👉 저장 기준을 더 높여라.

⚠ Memory Drift

오래된 belief가 최신 판단을 덮는 현상.

해결:

recency weighting

revision loop

decay

⚠ Retrieval Collapse

Top-K 과다 → 컨텍스트 오염.

해결:

aggressive pruning

importance threshold

13. Implementation Order (추천 — 그대로 가면 시행착오 적음)
Phase 1 — Distillation + Sparse Memory

→ raw dump 절대 금지.

Phase 2 — Hybrid Retrieval

→ similarity-only 금지.

Phase 3 — Revision Loop

→ 여기서 OpenSwarm이 "생각하는 시스템"으로 변함.

Phase 4 — Background Cognition

→ 장기 안정성 확보.

One Guiding Rule

기억은 많을수록 좋은 것이 아니다.
좋은 기억만 살아남는 시스템이 지능이다.