// GitHub repository search and clone, inside the "Add repository" dialog
// (AGT-4005). Consumes GET /api/github/repos?q= and POST /api/repos/clone.
//
// A classic script so supervisor.html can load it beside supervisor.js. Every
// fetch goes through the webToken.js seam, which adds the session token to
// same-origin API calls, so nothing here handles credentials.
//
// GitHub names are untrusted: they are written with textContent / dataset,
// never interpolated into HTML.
(function () {
  'use strict';

  const SEARCH_DEBOUNCE_MS = 250;
  const MAX_ROWS = 50;

  let searchSeq = 0;
  let debounceTimer = null;
  let loaded = false;

  function el(id) {
    return document.getElementById(id);
  }

  /** Readable message for a failed API response; never echoes a stack. */
  function errorMessage(status, body) {
    if (status === 503 && body && body.error === 'GH_TOKEN not configured') {
      return 'GitHub is not connected: set GH_TOKEN for the daemon.';
    }
    if (status === 409 && !(body && typeof body.error === 'string')) return 'Already cloned at the destination.';
    const detail = body && typeof body.error === 'string' ? body.error : 'HTTP ' + status;
    return detail.slice(0, 200);
  }

  async function readJson(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  function setStatus(text, tone) {
    const status = el('gh-status');
    if (!status) return;
    status.textContent = text || '';
    status.dataset.tone = tone || '';
    status.hidden = !text;
  }

  function badge(text, cls) {
    const span = document.createElement('span');
    span.className = 'repo-item-badge' + (cls ? ' ' + cls : '');
    span.textContent = text;
    return span;
  }

  function renderRepos(repos) {
    const list = el('gh-repo-list');
    if (!list) return;
    list.replaceChildren();
    if (!repos.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No matching GitHub repositories';
      list.appendChild(empty);
      return;
    }
    for (const repo of repos.slice(0, MAX_ROWS)) {
      const row = document.createElement('div');
      row.className = 'repo-item gh-repo';
      row.dataset.fullName = repo.fullName;

      const text = document.createElement('div');
      text.className = 'gh-repo-text';
      const name = document.createElement('div');
      name.className = 'repo-item-name';
      name.textContent = repo.fullName;
      text.appendChild(name);
      const note = document.createElement('div');
      note.className = 'repo-item-path gh-repo-note';
      text.appendChild(note);
      row.appendChild(text);

      if (repo.private) row.appendChild(badge('private', 'is-private'));
      if (repo.cloned) {
        row.appendChild(badge('cloned', 'is-cloned'));
      } else if (repo.nameTaken) {
        // Another repository already holds the destination directory (same
        // name, other owner): cloning would collide, so offer no action.
        row.dataset.state = 'name-taken';
        row.appendChild(badge('name taken', 'is-name-taken'));
        note.textContent = 'A different repository already uses this folder name.';
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary btn-sm gh-clone';
        button.textContent = 'Clone';
        button.dataset.fullName = repo.fullName;
        row.appendChild(button);
      }
      list.appendChild(row);
    }
  }

  async function searchGithubRepos(query) {
    const seq = ++searchSeq;
    setStatus('Searching GitHub…', 'muted');
    const q = String(query || '').trim();
    const url = '/api/github/repos' + (q ? '?q=' + encodeURIComponent(q) : '');
    try {
      const res = await fetch(url);
      const body = await readJson(res);
      if (seq !== searchSeq) return; // a newer search superseded this one
      if (!res.ok) {
        renderRepos([]);
        setStatus(errorMessage(res.status, body), 'danger');
        return;
      }
      const repos = Array.isArray(body) ? body.filter(function (r) {
        return r && typeof r.fullName === 'string';
      }) : [];
      renderRepos(repos);
      setStatus(repos.length > MAX_ROWS ? 'Showing the first ' + MAX_ROWS + '; refine the search.' : '', 'muted');
    } catch (e) {
      if (seq !== searchSeq) return;
      renderRepos([]);
      setStatus('GitHub search failed: ' + String(e && e.message || e).slice(0, 200), 'danger');
    }
  }

  function scheduleSearch(query) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      void searchGithubRepos(query);
    }, SEARCH_DEBOUNCE_MS);
  }

  async function cloneGithubRepo(button) {
    const fullName = button.dataset.fullName;
    if (!fullName || button.disabled) return;
    const row = button.closest('.gh-repo');
    const note = row && row.querySelector('.gh-repo-note');
    button.disabled = true;
    button.textContent = 'Cloning…';
    if (note) note.textContent = '';
    try {
      const res = await fetch('/api/repos/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: fullName }),
      });
      const body = await readJson(res);
      if (!res.ok) {
        if (note) note.textContent = errorMessage(res.status, body);
        if (res.status === 409 && body && body.nameTaken === true) {
          // Retrying cannot help: the folder belongs to another repository.
          if (row) row.dataset.state = 'name-taken';
          button.replaceWith(badge('name taken', 'is-name-taken'));
          return;
        }
        if (row) row.dataset.state = 'failed';
        button.disabled = false;
        button.textContent = 'Retry';
        return;
      }
      if (row) row.dataset.state = 'cloned';
      button.replaceWith(badge('cloned', 'is-cloned'));
      if (note) note.textContent = body && typeof body.destination === 'string' ? body.destination : 'Cloned';
      // supervisorPanels.js owns the Repositories panel; refresh it when present.
      if (typeof window.reloadProjectList === 'function') {
        try {
          await window.reloadProjectList();
        } catch (e) {
          // The clone succeeded; say the panel is stale rather than hide it.
          if (note) note.textContent += ' · Repository list did not refresh: ' + String(e && e.message || e).slice(0, 200);
        }
      }
    } catch (e) {
      if (note) note.textContent = 'Clone failed: ' + String(e && e.message || e).slice(0, 200);
      if (row) row.dataset.state = 'failed';
      button.disabled = false;
      button.textContent = 'Retry';
    }
  }

  function toggleGithubConnect() {
    const section = el('gh-connect');
    if (!section) return;
    section.hidden = !section.hidden;
    const toggle = el('gh-connect-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(!section.hidden));
    if (!section.hidden) {
      const input = el('gh-search');
      if (input) input.focus();
      if (!loaded) {
        loaded = true;
        void searchGithubRepos(input ? input.value : '');
      }
    }
  }

  function bind() {
    const toggle = el('gh-connect-toggle');
    if (toggle) toggle.addEventListener('click', toggleGithubConnect);
    const input = el('gh-search');
    if (input) input.addEventListener('input', function () { scheduleSearch(input.value); });
    const list = el('gh-repo-list');
    if (list) {
      list.addEventListener('click', function (event) {
        const target = event.target;
        const button = target && target.closest ? target.closest('button.gh-clone') : null;
        if (button) void cloneGithubRepo(button);
      });
    }
  }

  window.OpenSwarmGithubConnect = {
    searchGithubRepos: searchGithubRepos,
    cloneGithubRepo: cloneGithubRepo,
    toggleGithubConnect: toggleGithubConnect,
    bind: bind,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
