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
- [Detector](detector.json): one manual run, no findings.
- [HTTP proof](http-proof.json): two browser contexts, monotonic shared reads, lost-response idempotency, Origin/body gates, cursor pages and ended recipients.
- [Real provider receipts](live-receipts.json): coordinator response and exact task/actor/delivery reply, independently read back from canonical Threads. This is isolated native-provider proof, not production scheduler/deployment proof.
- [Scale HTTP measurements](scale-http.json): 25 samples at 10/100 and 100/1,000. RSS includes the complete instrumented Node process.
- [UI performance](ui-performance.json): five contexts at each fixture scale. This is read-only fixture rendering, not a live fleet.

JSON copies omit local temporary repository paths. Original evidence and isolated
databases remain on the development host. Reproduction commands and limitations
are in [the implementation record](../../design/project-collaboration-plan.md).
