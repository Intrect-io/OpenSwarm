---
version: 1
slug: "web-static"
primary_target: "web/static"
related_targets: ["src/support/dashboardHtml.ts","src/issues/issueBoardHtml.ts"]
---

# Surface brief: OpenSwarm web dashboard (all pages)

Scope: every page served from `web/static/` plus the Supervisor (`/`, migrating out of
`src/support/dashboardHtml.ts`) and the local issue board (`/issues`). Mode: **Operate** on
every page. Product truth lives in PRODUCT.md; this brief holds only cross-page structure.

## Job and audience
The operator checks whether the swarm is healthy and what needs them, acts in two presses,
and leaves. From a desk, the dashboard sits beside the editor. From a phone (390 px, over
Tailscale), the visit is one question and one action. A first-time OSS installer must
understand each page without the docs.

## Information architecture (confirmed 2026-10-19)
- **One shell, rendered from one module** (`web/static/js/shell.mjs`). It owns the brand,
  nav, status line and theme toggle. Pages mount it; no page hand-copies nav markup.
  - Brand → `/`. No page-title label beside it (it duplicated the active tab).
  - Nav order, fixed on every page: **Supervisor · Cockpit · Chat · Orchestration ·
    Threads**, then **More ▾** → Usage, Warehouse, Settings.
    Active item = `aria-current="page"`, contrast ≥ 4.5:1 in both themes.
  - Narrow viewports: the nav scrolls horizontally with an edge fade on whichever side has
    more items; the active item is scrolled into view on load.
- **Status line on every page**, under the nav, one row. It shows four facts and names the
  source of each:
  1. Link: live / reconnecting / offline (SSE).
  2. Daemon: running / stopped / dashboard-only, with the reason when not running.
  3. Provider: default adapter · model.
  4. Needs you: parked questions + failed/stuck work, linking to where to act.
  A healthy swarm reads as one calm line. Backed by a single aggregating read endpoint, so
  every page states the same facts.
- **Issues: one surface.** Cockpit's Issues view becomes the only Issues surface. It lists
  and deploys for any tracker, and adds create/edit when the tracker is local (ported from
  `issueBoardHtml.ts` over `/graphql`). `/issues` redirects to it. The Supervisor-only
  Issues tab is removed.
- **Settings page** (`/settings`, new) holds the web-token form, removed from Usage and
  Warehouse. When the server refuses for auth (`X-OpenSwarm-Auth`), the status line says
  "Locked: add a token" and links to Settings.
- **Supervisor migrates** to `web/static/supervisor.html` + ES modules. The provider list
  arrives over an API instead of string injection. Same API contracts.
  - Hierarchy, top to bottom: needs-you and failures → live work (pipeline + live log) →
    fleet controls → reference panels (repositories, monitors, coordination, agent chat).
  - Fleet controls split by risk:
    - routine (Heartbeat, PR review, provider, thinking);
    - service (Stop, Restart), set apart and confirmed in place.
  - Provider becomes a collapsed selector that keeps the two-press confirm.
  - Every panel header names its source and scope.
  - 390 px: one column in that same order. Reference panels are collapsible and start
    collapsed.

## States that matter
Healthy-and-idle (the most common state, must look calm, not empty), dashboard-only
(`openswarm dash`, no runner), locked (no token), reconnecting, parked question waiting,
failed work, first run with no repositories or issues.

## Constraints
Static HTML + ES modules, no framework or bundler. All colour literals in `tokens.css`
(`tokens.test.ts`). Dark and light both first-class. English UI. WCAG 2.2 AA. The Tauri
shell wraps these pages: no `window.confirm`. API contracts are unchanged unless a step
adds a read endpoint.

## Sequence (one PR per step)
4 visual world + tokens → 5 shell (nav, status line, Settings, mobile nav) → 6 Supervisor
migration + hierarchy → 7 copy pass (terms, IDs behind copy, English, time format,
tooltips) → 8 remaining layouts (Threads compose button, Orchestration legend/idle lanes,
12 px floor, Usage empty state, Issues consolidation) → 9 first-run and Warehouse setup
guidance → 10 polish.

## Direction contract

THESIS: Every run is a departure. The Supervisor is a station board. Active runs are set in
timetable columns: started, run, title, destination repo, platform worktree, agent·model,
stage, status. Anything that needs the operator is posted above the board as a yellow
platform-change notice. It refuses the category default: equal-weight bordered cards in
borrowed GitHub dark.

OWN-WORLD: Dark is the station board: navy ground (#0b1f4b), a deeper navy shell bar,
white ink, blue-grey secondary. Light is the printed timetable: white ground, navy ink. Two
colours are reserved:
- Timetable yellow (#ffd400) appears only on what needs the operator: the notice band and
  the needs-you count. On white it is a fill, never text.
- Vermilion means cancelled or failed, and nothing else.

Type is Barlow, self-hosted at 400/500/600, with tabular numerals everywhere. Column heads
are uppercase and tracked. Heads sit on a 2px rule and rows are split by hairlines. Corners
are 3px. There are no cards and no shadows.

STORY: The operator reads the yellow band first, because anything yellow needs them. Then
the board: what is running and what is late. Then they act from the controls row. A healthy
swarm shows no yellow band and one calm status line.

FIRST VIEWPORT:
- Shell bar: brand, nav with an underlined active item, theme switch.
- Status line: four facts, each with its source, and the yellow needs-you link at the right.
- Full-width yellow notice band: the count as its headline, then up to three rows (tag,
  run, repo, message, when, actions).
- A strip of fleet figures.
- The departure board table, with the time column large and right-aligned.
- A three-column live-log strip.
- Controls: routine on the left; Service (Stop/Restart) on the right, after a divider.

The count is a sentence inside the notice band, not a hero metric: no supporting-stat
cluster sits around it. At 390 px the band comes first, and board rows stack as time +
run / title / status.

FORM: Departure Board (SBB and Korail timetables), position 1 on the ordered list. The
signature move is the split-flap status change: when a run's status or stage changes, that
cell flips once (a short vertical clip transition, instant under reduced motion).
seed:a6b69a4a12b97b10

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
