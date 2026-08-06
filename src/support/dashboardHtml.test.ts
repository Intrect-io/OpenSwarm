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
