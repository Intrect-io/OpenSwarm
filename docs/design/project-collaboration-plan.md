# Project collaboration (AGT-4776)

Base: `1800f1e`, branch `feat/project-coordination-chat`. Keep #835 draft and
ports 3847/3899 untouched. Use an isolated preview on 3900.

## Implementation sequence

1. Define project/task identity, aggregate and cursor contracts. Build labelled,
   read-only normal/questions/busy/offline examples (10 projects/100 agents;
   stress 100/1,000). Preserve Departure Board and English UI.
2. Add SQLite channel projections referencing original trace/thread IDs,
   monotonic operator read positions, idempotent message + queue transactions,
   supervisor draining and durable execution recovery. Preserve existing APIs.
3. Connect project table, task details/bounded relationship graph, channel and
   discussion panes. Isolate drafts/attachments/requests by project and thread.
4. Verify identity/counts beyond the 500-entry board, paging, failures/restart,
   coordinator/task recipient delivery, cross-browser reads, scale, accessibility
   and responsive behavior. Run lint/typecheck/build, relevant/full tests, both
   OpenSwarm review gates and CI. Capture 390/1440 in both themes in one batched
   inspection and at most one confirmation pass; run detector once.

## Contracts

- Canonical repoKey; agent identity is repoKey + task ID + address.
- Running counts come from sessions/ledger; recent participants means 30 minutes.
  Unavailable sources never become zero. Questions use latest correlation state.
- Lists default to 50 with cursors and scope/partial metadata. A graph is limited
  to the chosen task and 20 nodes/40 edges, retains selection, and reports omissions.
- Normal posts target Project coordinator. Task replies name one valid active
  recipient. Never broadcast, enable projects or restart finished tasks.
- HTTP acceptance means saved/queued; processing, response, failure/interruption
  are separate durable states. Unknown crash outcomes require explicit retry.
- Read cursors only advance; imported history is a baseline. Advance automatically
  only in the foreground at the latest position. Text drafts use sessionStorage;
  files stay in memory. Late responses belong to their original scope.
- Configured repository channels are automatic; removed channels remain read-only.
  Existing Threads stay canonical, including multi-task discussions.

## Release gates

Keep deterministic fixture proof separate from actual provider/agent evidence.
Keep user visual approval distinct from automated checks. Do not merge until
#835 has merged, this branch has been reconciled with main, checks pass and the
user has approved the final responsive captures.

## Evidence

Verified 2026-10-19 on this branch; no production deployment was performed.

- Real native provider: codex-responses/gpt-5.6-luna. General coordinator request and exact task/actor inbox receipt both reached responded, with independently read-back original thread message IDs, nonce bodies and the task reply's exact replyToDeliveryId. Final isolated state: /var/folders/x4/5ltqqh6921176w4qz_gr6pr00000gn/T/project-collaboration-live-B8aUPr. This is not production scheduler or deployment proof.
- Two independent Chromium contexts against production channel routes and existing auth/body-reader gates: read cursor 50 stayed 50 after 10; second context saw 20 unread. Untrusted Origin 403, oversized body 413, lost-response retry returned a single queued delivery, 50/21 cursor pages, ended recipient 409. State/evidence: /tmp/agt4776-http.json.
- Browser matrix: 16 passed (390/1440px, dark/light, 720 CSS-px reflow, normal/questions/busy/offline/stress). 16 final captures under .impeccable/review-project-collaboration-confirm/. No JavaScript errors or attempted backend writes. 720px is a 200%-equivalent reflow check, not a physical-device browser-zoom claim.
- Detector: one manual run on final changed UI targets, zero findings. Visual review: one batched pass and one confirmation; screenshots are awaiting user approval.
- Scale: warm aggregation query p95 3.88ms (10 projects/100 participants) and 14.15ms (100/1,000); 25 observations per scale. Query includes complete stored events plus synthetic running sessions and a 50-item page; this is fixture evidence, not live fleet latency. Raw memory/RSS and browser render timings are retained in JSON.
- Final head validation and CI run links are recorded in the draft PR comments.


## API and storage notes

The reviewable [evidence gallery and JSON receipts](../evidence/agt-4776/README.md)
preserve the final captures and measurements in this branch.

GET /api/coordination/projects and /api/coordination/needs-you return cursor pages, source/partial metadata and complete totals. GET /api/coordination/projects/:repoKey/tasks lists tasks; /tasks/:taskId returns the bounded graph and participant/connection pages (search and part=connections).

GET /api/coordination/channels/:repoKey/entries uses a scoped snapshot cursor. POST /messages commits the original Threads message, a reference projection and a delivery together; the idempotency key is scoped to the project and conflicts on changed payloads. Task/recipient scope is checked against an actual running session/stage, or an exact unanswered question. A question answer is also committed as required durable answer evidence in the same transaction, preserving existing readmission policy.

GET /read supplies shared read metadata. POST /read accepts throughSeq and advances with MAX only. POST /deliveries/:id/retry requeues only failed/interrupted items and validates scope/recipient again. Archived projects stay readable, and no request accepts an arbitrary execution path.

coordination_channel_entries contains original source IDs, not copied bodies. Threads remain the canonical discussion, including cross-task links. coordination_channel_runs is the delivery execution journal: claim, response or interruption are durable. Coordinator processing uses the existing per-project file lock, adapter/policy, timeout and turn limits. The supervisor polls the durable queue every 15 seconds as well as receiving local wakeups; a separate dashboard process cannot lose a queued request merely by missing an in-memory notification. Missing coordinator configuration leaves the item queued. Unknown crash outcomes require an explicit retry. Task messages are claimed only by repoKey/task/address; the original thread reply settles the corresponding delivery.

Drafts and File objects are scoped in browser memory. Only text and retry identity/submitted text are kept in sessionStorage. Repeated sends reuse uploaded references and the same request identity. SSE updates show New activity without changing ordering, scroll or selection. Read updates require foreground focus and the latest loaded position.

## Reproduce

- npm test -- src/coordination/projectCollaboration.test.ts tests/web/projectWorkspace.test.ts
- node --import tsx scripts/project-chat-preview.ts 3900
- node --import tsx scripts/check-project-collaboration.ts http://localhost:3900 <capture-dir>
- node --import tsx scripts/check-project-zoom.ts http://localhost:3900 <evidence.json> (non-visual Chrome 100%/200% DOM assertions; no screenshots)
- node --import tsx scripts/measure-project-collaboration.ts <output.json>
- node --import tsx scripts/prove-channel-http.ts <evidence.json>
- node --import tsx scripts/prove-project-collaboration.ts <evidence.json> (opt-in: real configured provider calls in an isolated temporary repository)

All evidence scripts use isolated state; the preview imports no daemon/state/provider modules. The live-provider script is opt-in and never runs in the normal test suite. The host's 3847 and 3899 listeners were not restarted or replaced.

## Additional measurements and review corrections

The later measurement, with actual loopback HTTP responses and other checks running on the host, reported p95 42.5ms (10/100) and 219.8ms (100/1,000). Warm query p95 in that busier sample was 18.8/114.2ms. Initial 3.9/14.2ms observations above are retained, not replaced by the more favorable sample. RSS for the complete instrumented Node process was 298/255 MiB; before/after heap deltas are affected by GC and are not peak incremental fleet memory.

- UI 10/100: initial load 313–753ms; channel selection 691–891ms; JS heap 2555 KiB across five isolated Chromium contexts. This measures local read-only fixtures with the production UI, not a production fleet.
- UI 100/1000: initial load 274–497ms; channel selection 220–758ms; JS heap 3538 KiB across five isolated Chromium contexts. This measures local read-only fixtures with the production UI, not a production fleet.

OpenSwarm first returned gate-not-run on ollama-cloud HTTP 429. A codex-responses/gpt-5.6-sol review returned REVISE with two reproducible defects: answering one correlation closed another question on the task, and one generic task thread reply settled multiple claimed deliveries. Both regressions failed before the fix. New channel answers now settle only the exact correlation; original legacy answer APIs retain their compatibility behavior. Task replies must pass metadata.deliveryId as coordination_thread_reply.delivery_id, validated against project/thread/task/actor and the current processing delivery in the same message transaction. Unlinked discussion replies settle nothing. The stored replyToDeliveryId is independent readback evidence. Disabled-project recovery also reconciles unknown runs without executing them, and queue draining rechecks project enablement between messages.

A second review found source_task_id/task_id scope disagreement; the regression
failed before canonical source-task validation was fixed. The independent review
then reproduced and verified fixes for delayed Needs-you navigation and consumed
board-message loss on a channel DB failure. Inbox drains preserve successful
messages and attach inbox-source-unavailable diagnostics for failed sources;
without any messages, partial failure remains an explicit error.

The next OpenSwarm relation-pagination finding was UNFOUNDED: an independent run
used the production handler and SQLite to consume all 116 relationships as
50/50/16 (three HTTP 200 responses, 116 unique, zero missing). The UI and API use
part=connections with relationships.nextCursor; participant cursors are separately
scoped and are correctly rejected by that endpoint. The independent final review
approved its scope after both inbox failure directions were verified directly.

The completed OpenSwarm working-tree review returned APPROVE using
codex-responses/gpt-5.6-sol (600s / 60-turn ceiling). Earlier forced-final REVISE
records remain preserved; they are not approvals. Lint, typecheck and build passed
(12 pre-existing lint warnings, zero errors). The first frozen full run passed
7,534 tests but failed coverage (statements 89.08%, functions 89.98% against 90%).
Additional behavioral tests now cover task routing, relationship/search paging,
canonical discussion paging, history positioning, retry, actual SSE transport
reconnect, shared-read polling, archived channels and partial errors. The feature-head
focused collaboration suite passed 56 tests. Coverage floors remain unchanged;
the final full run and exact-head CI decide the release gate.

At 814b916, both OpenSwarm working-tree and fresh PR reviews approved. Standard
GitHub CI passed all seven jobs (7,548 tests / 12 platform skips, plus the separate
three-test Windows process-tree job); local coverage passed at statements 90.04%,
functions 90.94%, branches 81.82%, lines 92.52%. The separate CI model-review
workflow could not run because its existing OpenRouter credential returned 401
User not found. No shared credential was changed.

An additional independent migration probe then found that valid older Threads
stored under filesystem paths were not folded into the canonical channel. The
new regression failed before the repair. Registered aliases now apply to message
triggers/backfill, existing projection keys, thread-derived task aggregation and
Threads lookup/list/reply/resolve. Original repository strings, thread/message
IDs and projection seq remain intact; split read positions merge monotonically,
and obsolete duplicate channel metadata is hidden. Opaque keys remain opaque and
unrelated projects are rejected. The independent reviewer reopened its original
failed DB and verified repair, canonical HTTP lookup, exact delivery-linked reply
through the old path, and resolution. Its final verdict was APPROVE. Final-head
CI and reviews after this repair are linked in the PR comments.

After the legacy repair, the related five-suite check passed 76 tests. The real
native coordinator/task receipt check passed again. The fresh fixture measurement
reported query p95 3.36/14.61ms and loopback HTTP p95 4.02/14.68ms at 10/100 and
100/1,000 (25 observations each); initialization took 73/581ms, process RSS
281/299 MiB. The earlier busier-host observations above remain part of the record;
these fixture samples do not establish production latency.

The next migration review reproduced older traces whose explicit repo_key also
contained a filesystem path. That regression failed before repair. Known/path
identities now fold consistently in trace projection, project/relationship
queries, exact question answers and recipient-role reconciliation, while opaque
keys and original trace rows remain intact. Durable normalization also runs when
the live board is unavailable. The related five-suite check passes 77 tests.

A live migration probe also reproduced a sibling path first appearing after the
initial configuration sync. Incremental trace/thread high-water marks now register
new aliases without restarting; known aliases use their projection triggers and
do not repeatedly backfill history. A new sibling's unread messages, original
source IDs/seq/repository values and opaque-project isolation survive a normal
refresh. The expanded five-suite check passed 114 tests; lint, typecheck and build
passed again. That 25-sample fixture run reported query p95 3.73/17.08ms and
HTTP p95 6.58/18.56ms, initialization 77/584ms and total process RSS 289/308 MiB
at 10/100 and 100/1,000. All previous samples above remain documented.

The opaque-first ordering probe then failed two regression checks: registering an
opaque explicit event key could claim a new physical sibling alias, and later
path-key records inherited that wrong identity. Physical Git aliases and opaque
event identities are now independent. Backfill derives repaired projection keys
from their original trace/thread sources, preserving both opaque rows and original
IDs/seq. Both regressions and the related five suites passed (115 tests); lint,
typecheck and build passed with the same 12 existing warnings. Native coordinator
and exact task-delivery receipts passed again. With concurrent checks on the host,
that 25-sample fixture run reported query p95 18.01/140.32ms and HTTP p95
25.17/82.68ms, initialization 146/1,021ms and total process RSS 290/309 MiB.
These measurements and the earlier samples do not establish production latency.
The independent reviewer reopened the opaque-first failure DB with a normal
refresh and approved its scope: original seq 1/3, raw source fields and readSeq 0
remained unchanged, path/opaque sources separated, a new Thread increased unread
by one, and cross-project question/Threads and readonly checks passed. The
sanitized [receipt](../evidence/agt-4776/alias-repair.json) records that result.

The working-tree review at 02931fb returned APPROVE, but a further independent
non-Git migration probe found old opaque contamination survived normal refresh
and even explicit configuration, leaving a canonical question answer at HTTP 409.
Two new regression checks failed before repair. Physical path aliases now use a
bounded Git probe only when a fallback cell conflicts with a known alias: confirmed
non-Git directories can be corrected; missing, inaccessible or other failed
lookups preserve their known archived identity. Configuration uses conditional
upserts instead of ignoring old aliases. Original opaque event identities and
source rows remain intact. All five related suites passed (118 tests), including
the missing-worktree preservation check; lint/typecheck/build passed, and the two
browser HTTP proof and real native coordinator/task receipts passed again.
The independent reviewer reopened its original non-Git failure DB, verified normal
refresh and configuration with unchanged trace/thread high-water marks, received
HTTP 202 for both physical-project answers while opaque questions stayed open,
and confirmed missing archived aliases, original seq 1/2 and readSeq 0 were
preserved. Its verdict is APPROVE; [receipt](../evidence/agt-4776/nongit-repair.json).
The last 25-sample fixture run after this change reported query p95 3.11/15.80ms
and HTTP p95 6.06/14.60ms, initialization 68/543ms and total process RSS
279/300 MiB. Earlier busier-host samples remain recorded above.

At b3f1096, standard GitHub CI passed all seven jobs with coverage at statements
90.11%, branches 81.88%, functions 91.00% and lines 92.59%. The fresh PR review
then correctly returned REVISE: without SSE, activity beyond the first 50 projects
was not detected, and an unchanged read cursor hid a newer selected-channel seq.
Three direct regressions also reproduced a delayed explicit refresh hiding a
subsequently loaded page. Polling and refresh now follow cursor pages covering
all already-loaded projects; the active channel's latestSeq independently signals
New activity. Only advancing summary seq creates a notice, and project request
generations discard older results. Polling does not apply new ordering or entries.
All five related suites pass (121 tests), and lint/typecheck/build pass with the
same 12 existing warnings. The independent DOM/state reviewer approved all three
regressions, shared reads beyond page one, stale lower responses and channel
switches; [receipt](../evidence/agt-4776/project-polling.json).

The next working-tree review returned REVISE on a further pending-refresh race.
Both polling and SSE regressions directly failed: an older entries response
cleared a newer New activity notice. Activity notifications now advance a shared
generation, and explicit refresh only clears the generation it started with.
The two new cases pass, including a subsequent refresh consuming the new entry
and clearing the notice. The related five suites now pass 123 tests, and
lint/typecheck/build pass with the same existing warnings. This is separate from
project-list request generations.

Independent follow-up then found a repeated-known-version edge: poll could
observe the same seq during a refresh, increment its activity generation and keep
the notice after that seq was loaded. Its direct regression failed before repair.
Polling now tracks per-project observed seq, compared with both loaded summaries
and the selected channel's throughSeq. Only a newer observation advances activity;
SSE notifications retain their independent generation. The five related suites
pass 124 tests, including repeated known versions, new versions during refresh,
the next successful refresh and late channel switching. Lint/typecheck/build pass
with the same existing warnings.

The independent uneven-cursor probe reproduced another boundary: during a switch
from channel A through112 to B through12, B could inherit A's watermark and miss
its subsequent seq13. Project selection now resets throughSeq with the entries
and cursor. The direct regression failed before repair and passes afterward;
foreground read writes during loading use 0, then 12 only after B's entries load.
All five related suites pass 125 tests, and lint/typecheck/build pass with the
same existing warnings.
The independent reviewer approved the final scope after seven focused checks:
known13 repeats clear, genuinely new14 stays visible, and a delayed A112-to-B12
switch sends B read positions [0,12], leaving the unseen B13 unread. Previous
failed observations remain in the receipt alongside the corrected readback.

The remaining actual-browser zoom check passed eight non-visual assertions across
both routes and themes. Temporary Chrome profiles use Chromium's
[default partition zoom preference](https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/browser/ui/zoom/chrome_zoom_level_prefs.cc).
Runtime dimensions confirm 100%/200% page zoom: outer width stayed 1440, inner
width changed 1440 to 720, DPR changed 1 to 2 and visual viewport scale stayed 1.
Initial/detail views had no horizontal overflow, keyboard focus was reachable,
and no JavaScript errors or backend writes occurred. This added zero screenshots
and no manual visual pass; the existing 16 captures still await user approval.
The [zoom receipt](../evidence/agt-4776/browser-zoom.json) is separate from the
earlier equivalent-reflow check and from visual acceptance.

At c97b085, all seven standard CI jobs passed: 7,564 tests / 12 platform skips,
plus three Windows process-tree tests; coverage was statements 90.15%, branches
81.91%, functions 91.04% and lines 92.60%. The fresh PR review correctly returned
REVISE on one additional dispatch defect: POST to the read-only entries resource
fell through to message creation. Both parent and independent isolated production
handler probes returned 202 and created one original message/projection/delivery.
The direct regression failed before repair. The route now returns 405 before
reading a body; unsupported methods create no messages or queue items, while
normal POST messages still returns 202. The five related suites pass 126 tests,
and lint/typecheck/build pass with the same existing warnings. The two-browser
HTTP proof passed again with readSeq50 after stale10, Origin403, oversized-body413,
one delivery after a lost-response retry, pages50/21 and ended-recipient409.
The independent reviewer also approved 18 direct handler cases and 13 isolated
HTTP checks using the production app router and existing auth/body helpers:
normal/invalid JSON POST entries returns405 without parsing or mutations,
untrusted Origins return403, oversized valid write endpoints return413, normal
messages and idempotent retries work, and read positions never regress.
The [method receipt](../evidence/agt-4776/method-guard.json) preserves the original
failure alongside the corrected readback. No screenshots or visual pass were added.

At 8246ab8, the working-tree review returned APPROVE and standard CI passed all
seven jobs: 7,565 tests / 12 platform skips plus three Windows process-tree tests;
coverage was statements 90.15%, branches 81.91%, functions 91.02% and lines 92.60%.
The fresh Sol PR review could not finish because the provider was overloaded.
A task-local retry using the adapter's supported default Terra model returned
REVISE on a real compatibility gap: a first legacy Threads HTTP request could
normalize its repository before aliases were initialized. The independent real
server probe reproduced empty lists and 404 lookup/reply/resolve without any
preceding project/channel/shell query; a warm channel-query control passed.

Threads now prepares shared alias/projection state before standalone library and
HTTP operations. Omitting configured paths preserves existing flags and reads;
an explicit empty configuration still archives removed channels. Preparation is
outside the already-prepared delivery transaction, preserving its atomic rollback.
Two regressions failed before repair. The six related suites now pass 131 tests,
and lint/typecheck/build pass with the same 12 existing warnings and no errors.
Independent review reopened copies of its original cold failure DB using the
actual production server: all 13 HTTP cases passed from the first Threads request,
including standalone HTTP with no configuration argument. Original source and
projection IDs/seq/repository, the migration read baseline, later unread messages
and unrelated active channels were preserved. Explicit configuration removal,
forced delivery rollback, one successful retry and idempotent resend also passed.
The original failure DB was not changed. Its verdict is APPROVE; the
[sanitized receipt](../evidence/agt-4776/cold-threads.json) keeps the failure and
corrected readback together. No new screenshots or visual inspection were added.

Native coordinator and exact task/actor/delivery responses, plus the two-browser
HTTP read/idempotency/Origin/body/ended-recipient proof, passed again after this
change. The latest 25-sample fixture run measured query p95 3.25/16.86ms and HTTP
p95 7.21/14.93ms at 10/100 and 100/1,000 projects/agents, initialization 75/567ms
and total process RSS 302/323 MiB. Earlier samples above remain valid observations;
these isolated fixture measurements are not production or live-fleet benchmarks.
