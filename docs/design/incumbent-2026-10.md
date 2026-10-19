---
name: OpenSwarm Dashboard (incumbent, 2026-10)
description: Record of the shipped GitHub-Primer-derived system; the anti-reference for the 2026-10 redesign.
colors:
  canvas-dark: "#0d1117"
  surface-dark: "#161b22"
  elevated-dark: "#1c2128"
  code-ground-dark: "#0b0f14"
  ink-dark: "#e6edf3"
  ink-secondary-dark: "#b1bac4"
  ink-muted-dark: "#8b949e"
  hairline-dark: "#30363d"
  hairline-strong-dark: "#484f58"
  primer-blue: "#58a6ff"
  primer-blue-hover: "#79c0ff"
  primer-red: "#f85149"
  primer-amber: "#d29922"
  primer-green: "#3fb950"
  primer-violet: "#d2a8ff"
  canvas-light: "#ffffff"
  surface-light: "#f6f8fa"
  ink-light: "#1f2328"
  ink-muted-light: "#656d76"
  hairline-light: "#d0d7de"
  primer-blue-light: "#0969da"
  primer-red-light: "#cf222e"
  primer-amber-light: "#9a6700"
  primer-green-light: "#1a7f37"
typography:
  title:
    fontFamily: "Inter Variable, Inter, -apple-system, Segoe UI, Apple SD Gothic Neo, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
  panel-title:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.3
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.primer-blue}"
    textColor: "{colors.canvas-dark}"
    rounded: "{rounded.md}"
    height: "32px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-dark}"
    rounded: "{rounded.md}"
    height: "32px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.primer-red}"
    rounded: "{rounded.md}"
  panel:
    backgroundColor: "{colors.surface-dark}"
    rounded: "{rounded.md}"
  nav-link-active:
    backgroundColor: "rgba(88, 166, 255, 0.12)"
    textColor: "{colors.primer-blue}"
    rounded: "{rounded.md}"
---

<!-- INCUMBENT RECORD: written 2026-10-19 by `/impeccable document` (scan mode) from
     web/static/css/tokens.css + shell.css before the redesign. Descriptive language is
     inferred, not interviewed: this system is the anti-reference for the redesign and is
     replaced in the next step, not extended. Keep it as evidence of what is being left. -->

# Design System: OpenSwarm Dashboard (incumbent)

## Overview

**Creative North Star: "The Borrowed Console"**

The shipped dashboard is a faithful GitHub Primer skin: Primer's dark and light canvases,
its blue accent, its red/amber/green status trio, Inter, and 10 px rounded bordered panels.
It is calm, legible and well-engineered, with semantic tokens, light as a true value swap,
and a build test that forbids colour literals outside `tokens.css`. But nothing in it is
about running a swarm of agents. An unrelated developer tool could ship the same chrome.

The product-specific moments come from content, not from the system: swimlanes named
Operator / Control plane / Coordination / Tasks, one hue per agent role shared by chat,
graph and legend, and worker → reviewer → tester stage ticks on work cards.

**Key Characteristics:**
- Primer palette, dark-first, light as a value swap.
- Uniform 10 px-radius bordered panels at equal weight; no page heading.
- Pill-shaped tab links in a top bar that each page copies by hand.
- Status as small tinted pills; `--role-human` shares `--danger`'s red.
- Dense 12 px floor with 10–11 px exceptions on chips, timestamps and badges.

## Colors

GitHub's own Primer values, used semantically.

### Primary
- **Primer Blue** (#58a6ff dark / #0969da light): accent, links, active nav, primary
  buttons, the worker role and chart series 1. One hue doing five jobs.

### Neutral
- **Canvas** (#0d1117 / #ffffff), **Surface** (#161b22 / #f6f8fa), **Elevated** (#1c2128):
  page, panels, cards.
- **Ink** (#e6edf3 / #1f2328), **Secondary ink** (#b1bac4), **Muted ink** (#8b949e /
  #656d76): text tiers.
- **Hairline** (#30363d / #d0d7de): every panel and control border.

### Status and roles
- **Primer Red** (#f85149 / #cf222e): danger, failed status, **and the human/operator role**.
- **Primer Amber** (#d29922 / #9a6700): warning, pending, orchestrator role.
- **Primer Green** (#3fb950 / #1a7f37): success, reviewer role.
- **Primer Violet** (#d2a8ff / #8250df): review-agent role, route edges.

### Named Rules
**The Literal Lives Once Rule.** Every colour literal lives in `tokens.css`; `tokens.test.ts`
fails the build otherwise. (Keep this rule through the redesign.)

## Typography

**Body Font:** Inter Variable (with system and Korean fallbacks)
**Mono Font:** ui-monospace stack

**Character:** neutral product sans with a mono for identifiers. No display face, no
distinct page title on any page.

### Hierarchy
- **Title** (600, 20 px, 1.3): defined but unused by any page header.
- **Panel title** (600, 15 px, 1.3): every panel header, so every panel looks equally important.
- **Body** (400, 15 px, 1.6).
- **Label** (400, 12 px): metadata, chips, control labels; 10–11 px in `.task-chip`,
  `.tree-session .time`, `.thread-card .badge`, Supervisor coordination summary.
- **Lane label** (mono, letter-spaced, ~9–10 px uppercase): orchestration tiers.

## Layout

4 pt spacing scale (4–48 px). A 48 px sticky top bar (89 px when the nav wraps below
1100 px). Pages are fixed-viewport grids of equal panels (Supervisor: three columns of
seven panels under a 17-control bar and a 9-metric strip). Below 900 px or on coarse
pointers, controls grow to 44 px; below 480 px the page-title label hides. The mobile nav
scrolls horizontally with no overflow cue.

## Elevation & Depth

Flat. Depth comes from three tonal steps (canvas → surface → elevated) and 1 px hairlines.
The only blur is the top bar's translucent backdrop. No shadow vocabulary.

## Shapes

Gently rounded, uniform: 6 px (inline code, small), 10 px (buttons, inputs, panels,
nav pills), 16 px (large), full (chips, status pills). Every container has a 1 px border.

## Components

### Buttons
- **Shape:** 10 px radius, 32 px tall (28 px small; 44 px on touch).
- **Primary:** Primer Blue fill, dark ink. **Secondary:** transparent with hairline.
  **Danger:** red outline; armed state fills red (two-press confirm).
- **Focus:** 2 px canvas gap + 2 px accent ring.

### Navigation
- Brand (🐝 + "OpenSwarm"), a page-title label duplicating the active tab, then pill links;
  active link is accent text on accent-subtle (4.3:1 in light theme, below AA).
- Hand-copied into each of seven HTML files; three different orders in production.

### Panels
- Surface background, hairline border, 10 px radius, 36 px header with 15 px bold title.

### Status pills
- Tinted fill + coloured text + dot ("LIVE", "Unknown", "connected"); success/danger
  subtle pairs measure 4.1–4.4:1 in light theme.

## Do's and Don'ts

### Do:
- **Do** keep semantic token names and the single-file literal rule.
- **Do** keep one colour per agent role, always with a text label.
- **Do** keep in-place two-press confirmation for fleet-wide and destructive actions.

### Don't:
- **Don't** carry the Primer palette forward; it is someone else's identity.
- **Don't** give every panel the same weight and title size.
- **Don't** let the operator role share the danger red.
- **Don't** go below 12 px for anything a person needs to read.
