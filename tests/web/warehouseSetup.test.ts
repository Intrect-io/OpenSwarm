// @vitest-environment jsdom
//
// First run (redesign step 9): a missing warehouse folder used to show a red
// "Warehouse is not provisioned" and an upload form that could only fail. The
// page now says what the folder is for and how to create it.
import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(async () => {
  document.body.innerHTML = `
    <section id="setup" hidden><code id="setup-folder"></code></section>
    <section class="browser">
      <button id="up"></button><nav id="breadcrumbs"></nav><button id="refresh"></button>
      <table><tbody id="entries"></tbody></table>
    </section>
    <aside class="upload">
      <input id="file" type="file"><span id="file-label"></span>
      <input id="overwrite" type="checkbox"><button id="upload"></button>
      <span id="upload-directory"></span><p id="status"></p>
    </aside>`;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ error: 'Warehouse is not provisioned: /srv/warehouse does not exist' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  )));
  await import('../../web/static/js/warehouse.mjs');
});

describe('warehouse first run', () => {
  it('replaces the error with setup steps naming the folder the daemon expects', async () => {
    await vi.waitFor(() => expect((document.getElementById('setup') as HTMLElement).hidden).toBe(false));
    expect(document.getElementById('setup-folder')!.textContent).toBe('/srv/warehouse');
    expect((document.querySelector('.browser') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('.upload') as HTMLElement).hidden).toBe(true);
  });
});
