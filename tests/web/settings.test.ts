// @vitest-environment jsdom
//
// The web token now has one home (/settings). These cases moved here from the
// Usage page, which used to carry its own copy of the form, plus the new
// promise: "applied" is the daemon's verdict, not a saved string.

import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { startSettings } from '../../web/static/js/settings.mjs';

function shell(): Document {
  document.body.className = '';
  document.body.innerHTML = `
    <form id="token-form">
      <input id="web-token" type="password" />
      <button id="save-token" type="submit">Apply</button>
      <button id="clear-token" type="button">Forget</button>
      <p id="token-state"></p>
    </form>`;
  return document;
}

const respond = (status: number) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) });

function store(initial = '') {
  let token = initial;
  return {
    readToken: vi.fn(() => token),
    storeToken: vi.fn((next: string) => { token = next; }),
  };
}

const submit = (doc: Document) =>
  doc.getElementById('token-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const state = (doc: Document) => doc.getElementById('token-state')!.textContent;

describe('settings: web token', () => {
  it('applies a pasted token through the wrapper and reports the daemon\'s verdict', async () => {
    const doc = shell();
    const tokens = store();
    const fetchImpl = vi.fn(async () => respond(tokens.readToken() ? 200 : 403));
    const view = startSettings(doc, { tokenStore: tokens, fetchImpl });
    await view.ready;
    expect(state(doc)).toContain('needs a token');

    (doc.getElementById('web-token') as HTMLInputElement).value = ' secret ';
    submit(doc);
    expect(tokens.storeToken).toHaveBeenCalledWith('secret');
    // Cleared from the field so the credential does not sit in the DOM.
    expect((doc.getElementById('web-token') as HTMLInputElement).value).toBe('');
    await vi.waitFor(() => expect(state(doc)).toBe('A token is set for this tab and the daemon accepts it.'));
  });

  it('says so when the daemon refuses the token that was set', async () => {
    const doc = shell();
    const tokens = store('stale');
    const view = startSettings(doc, { tokenStore: tokens, fetchImpl: vi.fn(async () => respond(401)) });
    await view.ready;
    expect(state(doc)).toBe('The daemon refused the token set for this tab. Paste the current one.');
  });

  it('refuses an empty Apply instead of deleting the token that is working', async () => {
    // storeToken('') is the wrapper's REMOVE path; one stray click would log a
    // Tailscale operator out page-wide.
    const doc = shell();
    const tokens = store('working');
    const view = startSettings(doc, { tokenStore: tokens, fetchImpl: vi.fn(async () => respond(200)) });
    await view.ready;
    (doc.getElementById('web-token') as HTMLInputElement).value = '   ';
    submit(doc);
    expect(tokens.storeToken).not.toHaveBeenCalled();
    expect(state(doc)).toBe('Paste a token first.');

    // Forgetting is still an explicit, separate action.
    doc.getElementById('clear-token')!.click();
    expect(tokens.storeToken).toHaveBeenCalledWith('');
  });

  it('reports an unreachable daemon instead of a token problem', async () => {
    const doc = shell();
    const view = startSettings(doc, { tokenStore: store(), fetchImpl: vi.fn(async () => { throw new Error('offline'); }) });
    await view.ready;
    expect(state(doc)).toBe('The daemon did not answer. Check that it is running.');
  });
});
