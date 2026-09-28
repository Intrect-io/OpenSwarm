// @vitest-environment jsdom
//
// The repo pane and the pipeline pane are built by the browser script embedded
// in the page, so their escaping only exists as far as a real DOM parser is
// concerned: a value that survives the string builder can still be parsed as
// markup. These tests run the emitted script against the emitted markup — the
// way the dashboard runs — and inspect the resulting DOM.
//
// The defects they guard: a knowledge-graph hot-module name was interpolated
// raw, and a reviewer `decision` was concatenated straight into a class
// attribute, where escaping alone would not have been enough either — a quote
// ends the attribute no matter how the surrounding text is encoded.

import { describe, it, expect, vi } from 'vitest';
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

  it('renders a persistent fleet-wide thinking effort control', () => {
    const html = buildDashboardHtml(['openrouter']);
    expect(html).toContain('id="reasoning-effort"');
    expect(html).toContain('setReasoningEffort(this.value)');
    expect(html).toContain('/api/reasoning-effort');
    expect(html).toContain('<option value="high">High</option>');
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

// The repo and pipeline panes are built by the browser script embedded in this
// page, so their escaping is only settled once a real parser has looked at the
// result: a value that survives the string builder can still be read as markup.
// These run the emitted script against the emitted body — extracted from the
// page, never re-typed here — and inspect the DOM it produces.
interface DashboardScript {
  handleEvent(event: unknown): void;
  fetchKnowledgeData(): Promise<void>;
  expandProject(key: string): void;
}

function isDashboardScript(value: unknown): value is DashboardScript {
  return (
    typeof value === 'object' && value !== null &&
    'handleEvent' in value && typeof value.handleEvent === 'function' &&
    'fetchKnowledgeData' in value && typeof value.fetchKnowledgeData === 'function' &&
    'expandProject' in value && typeof value.expandProject === 'function'
  );
}

/**
 * Load the emitted page into jsdom and evaluate the script it ships, with
 * `routes` answering the dashboard's API calls. Timers are stubbed so nothing
 * renders behind the test's back; `projects` and `expandedProjects` are
 * closures in that script, so they are driven through the accessors returned
 * by the evaluated code rather than from outside.
 */
function loadDashboard(routes: Record<string, unknown>): DashboardScript {
  const html = buildDashboardHtml(['claude']);
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/);
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/);
  if (!body || !script) throw new Error('dashboard body or inline script not found in emitted HTML');

  document.body.innerHTML = body[1].replace(/<script[\s\S]*?<\/script>/g, '');

  const fetchStub = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input).split('?')[0];
    return new Response(JSON.stringify(path in routes ? routes[path] : []), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  class EventSourceStub {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    close(): void {}
  }

  const noopTimer = (): number => 0;
  const expose = 'return { handleEvent: handleEvent, fetchKnowledgeData: fetchKnowledgeData,'
    + ' expandProject: function(key) { expandedProjects.add(key); } };';

  const evaluate = new Function('fetch', 'EventSource', 'setTimeout', 'setInterval', script[1] + '\n' + expose);
  const api: unknown = evaluate(fetchStub, EventSourceStub, noopTimer, noopTimer);
  if (!isDashboardScript(api)) throw new Error('dashboard script did not expose its test surface');
  return api;
}

const HOSTILE_PROJECT = {
  name: 'hostile-proj',
  path: '/tmp/hostile-proj',
  enabled: true,
  running: [],
  queued: [],
  pending: [],
};

describe('knowledge-graph hot module names reach the DOM as text', () => {
  it('does not let a hot module name become live markup', async () => {
    const script = loadDashboard({
      '/api/projects': [HOSTILE_PROJECT],
      '/api/knowledge': [{
        slug: HOSTILE_PROJECT.name,
        summary: {
          totalModules: 2,
          totalTestFiles: 0,
          untestedModules: [],
          avgChurnScore: 0.25,
          hotModules: ['src/<script src=x>', 'src/<img src=x onerror=alert(1)>'],
        },
      }],
    });

    const list = document.getElementById('project-list')!;
    await vi.waitFor(() => expect(list.querySelector('.proj-card')).toBeTruthy());
    script.expandProject(HOSTILE_PROJECT.path);
    await script.fetchKnowledgeData();

    // The names arrive as characters...
    expect(list.textContent).toContain('<script src=x>');
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>');
    // ...rather than as elements, which is what an unescaped name produces.
    expect(list.querySelector('script')).toBeNull();
    expect(list.querySelector('img')).toBeNull();
  });
});

describe('reviewer decision is a class token, not markup', () => {
  it('cannot break out of the class attribute', () => {
    const script = loadDashboard({});
    const list = document.getElementById('stage-list')!;

    script.handleEvent({
      type: 'pipeline:stage',
      data: { stage: 'reviewer', status: 'complete', decision: 'approve" onmouseover="alert(1)' },
    });

    expect(list.querySelector('[onmouseover]')).toBeNull();
    // Whatever lands in the attribute must still be a valid, inert class token:
    // escaping alone would leave the quote free to end the attribute.
    const spans = list.querySelectorAll('.ssummary span, .sd-val span');
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.getAttribute('onmouseover')).toBeNull();
      expect(span.getAttribute('class') ?? '').toMatch(/^[a-z0-9_-]*$/);
    }
    // The decision is still shown; only its styling hook is constrained.
    expect(list.querySelector('.ssummary')!.textContent).toContain('APPROVE" ONMOUSEOVER="ALERT(1)');
  });

  it('keeps the styling hook for every decision supervisor.css defines', () => {
    const script = loadDashboard({});
    const list = document.getElementById('stage-list')!;

    for (const decision of ['approve', 'revise', 'reject']) {
      script.handleEvent({
        type: 'pipeline:stage',
        data: { stage: 'reviewer', status: 'complete', decision },
      });
    }

    for (const decision of ['approve', 'revise', 'reject']) {
      expect(list.querySelector('.sd-decision-' + decision)).toBeTruthy();
    }
  });
});
