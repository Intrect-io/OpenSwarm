# Dashboard responsive browser check

Requires the project's npm dependencies and an installed Google Chrome. Run
against a reachable OpenSwarm dashboard with real data:

```sh
npm run test:responsive -- http://localhost:3847 /tmp/openswarm-responsive
```

The default mode serves this checkout's `/static/` assets to the test browser
while retaining the running server's HTML and API/SSE responses. It does not
modify the server. To inspect deployed assets instead, append `--live`.
Non-GET/HEAD requests are aborted, so the check cannot dispatch work, send a
message, change a provider, or stop/restart the daemon.

The check visits Supervisor, Cockpit, Chat, Orchestration, Threads and Warehouse
at 320, 390, 768, 1024 and 1440 CSS pixels in light and dark themes. It verifies
viewport overflow, reachable navigation, mobile form/detail separation,
conversation access, sidebar positioning, input font sizes, desktop panel
containment and the chat composer in a shortened viewport. A running API must
answer successfully before each check. It writes `results.json` and full-page
screenshots for 390 and 1440 pixels to the output directory.

Inspect those screenshots as well as the assertions: populated content can
expose layout defects that a page-width check alone cannot catch. Chrome mobile
emulation does not prove physical iOS keyboard or Safari safe-area behavior.
The preview does not replace server-rendered HTML; verify HTML changes against
a build serving this checkout or with `--live` after deployment.
