import { mountShell } from './shell.mjs';
import { startProjectWorkspace } from './projectWorkspace.mjs';
export async function mountProjectWorkspace(doc) {
  const scenario = new URL(doc.defaultView.location.href).searchParams.get('demo');
  if (scenario) {
    const { createProjectFixture } = await import('./projectFixtures.mjs');
    const fixture = createProjectFixture(scenario);
    mountShell(doc, { fetchImpl: async () => ({ ok: true, json: async () => ({
      daemon: { state: 'dashboard-only', reason: 'Read-only demo data', uptimeMs: null }, provider: null,
      needsYou: { total: fixture.totals.needsYou, questions: fixture.needs.length, parked: 0 },
      partial: fixture.partial, unavailable: fixture.unavailable, generatedAt: fixture.generatedAt,
    }) }) });
  } else mountShell(doc);
  return startProjectWorkspace(doc);
}

if (typeof document !== 'undefined') void mountProjectWorkspace(document);
