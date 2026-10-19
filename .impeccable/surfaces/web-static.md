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
