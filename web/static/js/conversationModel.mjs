/**
 * Last agent (non-human actor) to speak about this task, or null if none has
 * yet. Also excludes `actorRole: 'daemon'`: `adapter-route`
 * (`src/agents/worker.ts`'s `recordRoute`, actor `adapter-router`) and
 * `mcp-audit` (`daemonActor` in `runCoordination.ts`/`orchestratorAgent.ts`,
 * actor `openswarm-daemon`) are both stamped `actorRole: 'daemon'` — neither
 * identity ever runs an agentic loop or calls `coordination_read`, so
 * addressing either would silently strand the operator's reply forever
 * (AGT-4059). `review-run` events keep `actorRole: 'review-agent'` (a real
 * agent's own call sign, `periodicReview.ts`) and must stay addressable, so
 * the candidate pool is `isUtterance` — not `isAgentMessage`, which would
 * drop every `SYSTEM_EVENT_KINDS` event (adapter-route, review-run,
 * mcp-audit, council-update) before the role check ever ran. Keep in sync
 * with the CLI port in `src/cli/attachHandler.ts`.
 */
export function latestAddressable(events) {
  const spoken = events.filter(isUtterance).sort((a, b) => a.seq - b.seq);
  for (let i = spoken.length - 1; i >= 0; i -= 1) {
    if (spoken[i].actorRole !== 'human' && spoken[i].actorRole !== 'daemon') return spoken[i];
  }
  return null;
}