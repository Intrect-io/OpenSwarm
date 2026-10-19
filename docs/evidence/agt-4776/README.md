# AGT-4776 evidence — 2026-10-19

Read-only demo captures use the production workspace UI. All fixture, HTTP and
provider checks ran with isolated state. Production ports 3847/3899 were untouched.
Captures await the operator's visual approval; automated checks do not grant it.

| Surface | 1440 dark | 1440 light | 390 dark | 390 light |
| --- | --- | --- | --- | --- |
| Orchestration projects | [View](screens/orchestration-1440-dark-projects.png) | [View](screens/orchestration-1440-light-projects.png) | [View](screens/orchestration-390-dark-projects.png) | [View](screens/orchestration-390-light-projects.png) |
| Orchestration task | [View](screens/orchestration-1440-dark-detail.png) | [View](screens/orchestration-1440-light-detail.png) | [View](screens/orchestration-390-dark-detail.png) | [View](screens/orchestration-390-light-detail.png) |
| Chat channels | [View](screens/chat-1440-dark-projects.png) | [View](screens/chat-1440-light-projects.png) | [View](screens/chat-390-dark-projects.png) | [View](screens/chat-390-light-projects.png) |
| Chat discussion | [View](screens/chat-1440-dark-detail.png) | [View](screens/chat-1440-light-detail.png) | [View](screens/chat-390-dark-detail.png) | [View](screens/chat-390-light-detail.png) |

- [Browser matrix](browser-results.json): responsive behavior, JS errors and attempted writes. 720 CSS-px checks are 200%-equivalent reflow, not physical-device zoom evidence.
- [Actual browser zoom](browser-zoom.json): eight non-visual DOM checks at Chrome 100%/200% in both themes and routes. The 1440px browser window remained fixed while inner width changed from 1440 to 720 and DPR from 1 to 2; visual viewport scale stayed 1. No additional screenshots or visual review.
- [Detector](detector.json): one manual run, no findings.
- [HTTP proof](http-proof.json): two browser contexts, monotonic shared reads, lost-response idempotency, Origin/body gates, cursor pages and ended recipients.
- [Real provider receipts](live-receipts.json): coordinator response and exact task/actor/delivery reply, independently read back from canonical Threads. This is isolated native-provider proof, not production scheduler/deployment proof.
- [Legacy repair readback](legacy-repair.json): the independent review's original failed database, repaired with original thread/message IDs and projection seq intact; exact delivery reply and resolution verified. Regression tests also assert the original repository string and read position remain intact.
- [Incremental alias repair](alias-repair.json): independent normal-refresh readback of the opaque-first failure database; original IDs/seq/read position, opaque separation, shared-correlation answer scope and readonly configuration verified. Independent verdict APPROVE, separate from CI and visual approval.
- [Non-Git alias repair](nongit-repair.json): independent original-failure readback and configuration transition without new records; physical answers return 202, opaque questions stay separate, missing archived aliases and original IDs/seq/read positions remain intact. Independent verdict APPROVE.
- [Project polling](project-polling.json): independent DOM/state review of all loaded cursor pages, shared reads and delayed refreshes. New versions remain visible while repeated known versions clear after refresh; uneven channel cursors cannot contaminate activity or foreground reads. Selection, ordering, scroll, entries and drafts remain unchanged until explicit refresh. Independent verdict APPROVE; no screenshots or visual review.
- [Method guard](method-guard.json): independent original POST-entries failure, 18 direct handler cases and 13 isolated HTTP checks. Unsupported methods return 405 before body parsing, with no message/queue mutations. Normal messages, idempotency, monotonic reads, Origin 403 and body-limit 413 remain intact. Independent verdict APPROVE.
- [Scale HTTP measurements](scale-http.json): 25 samples at 10/100 and 100/1,000. RSS includes the complete instrumented Node process.
- [UI performance](ui-performance.json): five contexts at each fixture scale. This is read-only fixture rendering, not a live fleet.

JSON copies omit local temporary repository paths. Original evidence and isolated
databases remain on the development host. Reproduction commands and limitations
are in [the implementation record](../../design/project-collaboration-plan.md).
