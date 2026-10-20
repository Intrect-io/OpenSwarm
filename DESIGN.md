---
name: OpenSwarm Dashboard — Departure Board
description: Every run is a departure; what needs the operator is posted in timetable yellow.
---

<!-- Implementation reference: web/static/css/tokens.css and the shared shell.
     Updated 2026-10-19 for Step 10. The replaced Primer-derived system is
     recorded in docs/design/incumbent-2026-10.md. -->

# Design System: OpenSwarm Dashboard (Departure Board)

## Overview

**Creative North Star: "The Departure Board"**

The swarm reads like a station. Active runs are departures set in timetable columns:
started, run, title, destination repository, platform worktree, agent and model, stage,
status. Anything that needs the operator is posted above the board as a yellow
platform-change notice. A healthy swarm shows no yellow at all.

The world lends type, palette, density and one signature move. Navigation and controls
stay standard web controls.

**Key Characteristics:**
- Dark is the station board: navy ground, white ink. Light is the printed timetable: white
  ground, navy ink, under the same navy shell band.
- Timetable yellow is reserved for what needs the operator; vermilion means failed or
  cancelled, nothing else.
- Tabular numerals everywhere; uppercase tracked column heads; rules, not cards.
- Live status and stage changes update in place. The proposed split-flap transition is
  not implemented; it is not an acceptance claim for this build.

## Colors

Two grounds, one ink, two reserved signals.

### Named Rules
**The Yellow Means You Rule.** Timetable yellow (`--needs`) appears only on things waiting
for the operator. On a white ground it is a fill, never text.

**The Vermilion Means Stopped Rule.** `--danger` marks failed, cancelled and destructive
actions only. The operator's role colour is the yellow family, never the failure red.

**The Literal Lives Once Rule.** Every colour literal lives in `tokens.css`; `tokens.test.ts`
and `tokenContrast.test.ts` gate placement and WCAG 2.2 AA contrast in both themes.

## Typography

**UI Font:** Barlow (self-hosted, SIL OFL) at 400/500/600, system and Korean fallbacks.
**Mono Font:** system monospace, for code, logs and run identifiers only.

**Character:** a signage grotesk set like a timetable: large right-aligned times, quiet
column heads, nothing below 12 px.

## Layout

Full-width rows on a 4 pt rhythm. Sections are separated by rules and space, never boxed.
On a phone the notice band comes first and board rows stack.

## Elevation & Depth

Flat. Depth is the step from shell band to ground to elevated control, plus 1–2 px rules.
No section shadows. The folder-picker dialog alone uses a scrim shadow to separate
a blocking selection task from the page. Keyboard focus uses the shared focus ring.

## Shapes

Printed edges: 2–3 px corners on controls and tags; full rounding only on status dots.

## Do's and Don'ts

### Do:
- **Do** post everything that needs the operator in the yellow notice band, with its action.
- **Do** keep times, counts and money in tabular numerals.
- **Do** name the source of every status, count and colour.

### Don't:
- **Don't** use yellow for decoration, warnings or delays; delays are `--warning` orange.
- **Don't** box sections in cards or add shadows.
- **Don't** make the board a costume: no fake split-flap tiles, no LED dot fonts.

## Shared shell and responsive behavior

The shell owns navigation, theme, the status line and an accessible page heading.
Page-specific controls stay beneath it: Threads keeps repository/status filters in
its list toolbar; Usage keeps the time window and refresh control in its main area.
Usage, Settings and Warehouse share `--page-gutter`: 24px, reduced to 16px at
600px and below. Workspaces retain their pane-specific padding.

At 800px and below, Threads stacks the list, optional compose form and selected
thread. With no selection (including after a filter removes it), the detail pane
takes no space. Compose fields keep visible labels; opening and cancelling the
form update the toggle's expanded state. Narrow-screen inputs use at least 16px
text and primary navigation and action controls have 44px touch targets.

## Components and browser surfaces

Controls use 2–3px corners, with 6px reserved for larger dialogs. Tags use squared
2px corners; dots and scrollbar thumbs may be fully rounded. Self-hosted Barlow
uses 400/500/600 weights; the token scale starts at 12px. Drawn SVG icons share
currentColor; log and status text retain their meaning without icons or colour.
Text selection, caret, scrollbars and keyboard focus consume semantic tokens.

## Verification boundary

Colour placement and contrast are checked by the web test suite. The read-only
responsive script checks eight routes, five widths and both themes against a
running preview; it blocks backend mutations. Screenshots support direct human
visual review. Automated checks do not establish visual approval, and a
`dashboard-only` preview does not prove attached-runner actions.

The detector's Orchestration spacing warning is intentionally retained: 4px
spacing repeats within metadata/chips and compact control padding, while event
rows use 8px and detail/transcript sections use 12px. This is local grouping,
not a single spacing value across page sections.

## Project collaboration

Orchestration starts with the Project / Running tasks / Recent participants ·
30m / Needs you timetable. Selecting a project opens its tasks; selecting a task
uses that space for details and a relationship graph. The graph is limited to
20 participants and 40 connections, with omissions and complete searchable,
paginated lists. Running state comes from scheduler sessions, recent activity
has an explicit 30-minute window, and missing sources display Unavailable.

Chat uses project channels, the channel timeline, and a selected original
Threads discussion or task context. On narrow screens the same sequence uses
Back controls; the composer can be expanded while its project/task/recipient
scope stays visible. Unread and Needs you have distinct labels and data.
Archived project channels remain read-only. Updates announce New activity and
wait for an explicit refresh. Saved/queued, processing, responded, failed and
interrupted delivery states retain their meaning independently of HTTP success.

The isolated 3900 preview explicitly labels demo data and disables writes.
Normal, questions, busy, offline and stress examples share the production UI.
Visual captures support operator approval; automated checks do not grant it.
