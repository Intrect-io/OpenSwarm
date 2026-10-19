---
name: OpenSwarm Dashboard — Departure Board
description: Every run is a departure; what needs the operator is posted in timetable yellow.
---

<!-- SEED: established with the user before implementation (2026-10-19 direction round,
     seed:a6b69a4a12b97b10); re-run /impeccable document once the Supervisor is rebuilt to
     capture the actual tokens and components. Token values live in web/static/css/tokens.css.
     The replaced Primer-derived system is recorded in docs/design/incumbent-2026-10.md. -->

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
- Signature move: the split-flap status change. When a run's status or stage changes, that
  cell flips once.

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
No shadows.

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
