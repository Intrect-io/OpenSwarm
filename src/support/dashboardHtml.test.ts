import { describe, it, expect } from 'vitest';
import { buildDashboardHtml } from './dashboardHtml.js';
import { listAdapterNames } from '../adapters/index.js';

describe('buildDashboardHtml (INT-3284)', () => {
  it('emits a button for every registered adapter', () => {
    const providers = listAdapterNames();
    const html = buildDashboardHtml(providers);
    expect(html).not.toContain('<!--PROVIDER_BUTTONS-->');
    for (const name of providers) {
      expect(html).toContain(`id="provider-${name}"`);
      expect(html).toContain(`switchProvider('${name}')`);
    }
    // Legacy hardcoded pair must not be the only buttons — registry has more.
    expect(providers.length).toBeGreaterThan(2);
    expect(html.match(/class="provider-btn"/g)?.length).toBe(providers.length);
  });

  it('highlights any active provider via class toggle script (not Claude/Codex-only)', () => {
    const html = buildDashboardHtml(['openrouter', 'claude']);
    expect(html).toContain('querySelectorAll(".provider-btn")');
    expect(html).not.toContain('getElementById("provider-claude").classList.toggle');
  });
});

// The stage row is rendered by the *browser* script embedded in this page, so a
// server-side test can only pin the emitted source. That is still the useful
// guard: every other externally-derived field in this row goes through
// escapeHtml/escapeAttr, and status was the one that did not. (AGT-3476)
describe('stage row escaping (AGT-3476)', () => {
  const html = buildDashboardHtml(['claude']);

  it('routes stage status through the escapers in both the class and the label', () => {
    expect(html).toContain('"<div class=\\"sdot " + escapeAttr(r.status || "") + "\\"></div>"');
    expect(html).toContain('"<div class=\\"sstatus\\">" + escapeHtml(r.status || "") + "</div>"');
  });

  it('escapes knowledge-graph hot module names before innerHTML insert', () => {
    expect(html).toContain('escapeHtml(m.split("/").pop() || "")');
    expect(html).not.toContain('map(function(m){return m.split("/").pop()})');
  });

  it('allowlists pipeline decision values before using them as CSS classes', () => {
    expect(html).toContain('/^(approve|revise|reject)$/i.test');
    expect(html).toContain('sd-decision-" + safe');
    expect(html).not.toContain('sd-decision-" + r.decision');
  });

  it('leaves no unescaped status interpolation behind', () => {
    // The exact shape the fix replaced. Catches a partial revert of either site.
    expect(html).not.toContain('"sdot " + (r.status || "")');
    expect(html).not.toContain('">" + (r.status || "") + "</div>"');
  });

  it('defines both escapers in the browser script that calls them', () => {
    // A server-side-only helper would make the row throw ReferenceError at runtime.
    expect(html).toContain('function escapeHtml(text)');
    expect(html).toContain('function escapeAttr(text)');
  });
});
