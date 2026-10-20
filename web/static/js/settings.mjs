// Settings: the one place to enter the web token. (Dashboard redesign, step 5)
//
// Usage and Warehouse each carried their own copy of this form. The token
// itself is owned by webToken.js; this page only writes through its store and
// then asks the daemon whether the token is accepted, so "Applied" means
// "the daemon let us in", not "we saved a string".

import { mountShell } from './shell.mjs';

export function startSettings(doc, { tokenStore, fetchImpl } = {}) {
  const store = () => tokenStore ?? doc.defaultView?.OpenSwarmWebToken;
  const fetcher = fetchImpl ?? ((url, init) => fetch(url, init));
  const form = doc.getElementById('token-form');
  const input = doc.getElementById('web-token');
  const state = doc.getElementById('token-state');
  const say = (text, tone = '') => {
    state.textContent = text;
    state.dataset.tone = tone;
  };

  // Ask a gated endpoint: the answer is what the token is actually worth.
  const probe = async () => {
    try {
      const response = await fetcher('/api/shell-status');
      if (response.status === 401 || response.status === 403) return 'refused';
      return response.ok ? 'accepted' : 'unreachable';
    } catch {
      return 'unreachable';
    }
  };

  const describe = async () => {
    const saved = !!store()?.readToken?.();
    const result = await probe();
    if (result === 'accepted') say(saved ? 'A token is set for this tab and the daemon accepts it.' : 'This browser does not need a token (local or trusted address).', 'ok');
    else if (result === 'refused') say(saved ? 'The daemon refused the token set for this tab. Paste the current one.' : 'This browser needs a token. Paste the one the daemon was started with.', 'warn');
    else say('The daemon did not answer. Check that it is running.', 'bad');
    return result;
  };

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = input.value.trim();
    // An empty Apply must not erase a working token (the wrapper's store
    // treats '' as remove).
    if (!token) { say('Paste a token first.', 'warn'); return; }
    store()?.storeToken(token);
    input.value = '';
    say('Checking…');
    await describe();
  });
  doc.getElementById('clear-token')?.addEventListener('click', async () => {
    store()?.storeToken('');
    say('Forgot the token for this tab.');
    await describe();
  });

  return { ready: describe() };
}

if (typeof document !== 'undefined' && document.body?.classList.contains('page-settings')) {
  mountShell(document);
  startSettings(document);
}
