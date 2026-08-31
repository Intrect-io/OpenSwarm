import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

const { openBrowser } = await import('./openBrowser.js');

/** A spawn() stand-in whose exit can be driven per test. */
function fakeChild(): EventEmitter {
  const child = new EventEmitter();
  spawnMock.mockReturnValue(child);
  return child;
}

let errors: string[];
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = [];
  spawnMock.mockReset();
  errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  errSpy.mockRestore();
});

const URL = 'https://linear.app/oauth/authorize?client_id=x&code_challenge=y';

describe('openBrowser', () => {
  // The launcher exiting 0 does not mean a human saw the page — over SSH or in a
  // container it can succeed and go nowhere, and the caller then blocks on a
  // callback that never arrives. So the URL is printed unconditionally.
  it('prints the URL even when the launcher succeeds', () => {
    const child = fakeChild();
    openBrowser(URL);
    child.emit('close', 0);
    expect(errors.join('\n')).toContain(URL);
  });

  it('prints the URL before spawning, not after the child settles', () => {
    fakeChild();
    openBrowser(URL);
    // No close/error emitted yet: the URL must already be out.
    expect(errors.join('\n')).toContain(URL);
  });

  it('adds a distinct notice when the launcher fails to start', () => {
    const child = fakeChild();
    openBrowser(URL);
    child.emit('error', new Error('ENOENT'));
    expect(errors.join('\n')).toMatch(/열지 못했습니다/);
  });

  it('adds the notice on a non-zero exit', () => {
    const child = fakeChild();
    openBrowser(URL);
    child.emit('close', 1);
    expect(errors.join('\n')).toMatch(/열지 못했습니다/);
  });

  it('does not add the failure notice on a clean exit', () => {
    const child = fakeChild();
    openBrowser(URL);
    child.emit('close', 0);
    expect(errors.join('\n')).not.toMatch(/열지 못했습니다/);
  });

  it('reports the launcher failure only once', () => {
    const child = fakeChild();
    openBrowser(URL);
    child.emit('error', new Error('ENOENT'));
    child.emit('close', 1);
    const hits = errors.filter((l) => /열지 못했습니다/.test(l)).length;
    expect(hits).toBe(1);
  });
});
