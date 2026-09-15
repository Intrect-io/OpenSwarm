// Shared jsdom shell fixture (AGT-4202).
//
// The contract tests used to hand-build miniature copies of the page shells,
// so the shipped markup (<textarea> composer, #scroll-latest, #resolve-confirm)
// drifted away from what the tests exercised. Loading the real web/static/*.html
// keeps the tests on the exact DOM the daemon serves.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STATIC_ROOT = join(__dirname, '..', '..', '..', 'web', 'static');

/**
 * Load a shipped shell (web/static/<page>.html) into the jsdom body and
 * return the document. Page scripts are stripped — the modules under test are
 * imported directly, and inline bootstrapping must not double-run.
 */
export function loadShell(page: 'chat.html' | 'orchestration.html' | 'threads.html'): Document {
  const source = readFileSync(join(STATIC_ROOT, page), 'utf8');
  const body = source.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  return document;
}
