import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { publicationCommandIn, publicationFenceMessage } from './publicationFence.js';
import { executeTool, type ToolCall } from './tools.js';

describe('publicationCommandIn (AGT-4418)', () => {
  it.each([
    ['git push -u origin swarm/AX-1434', 'git push'],
    ['git add -A && git commit -m "feat" && git push', 'git push'],
    ['gh pr create --title x --body "Closes AX-1434"', 'gh pr'],
    ['gh pr ready 533', 'gh pr'],
    ['gh api repos/o/r/pulls -f title=x', 'gh api …/pulls'],
    ['openswarm pr review --fresh --number 533', 'openswarm CLI'],
    ['git remote set-url origin https://x', 'git remote change'],
    ['git "push" origin HEAD', 'git push'],
    ['cd apps && git\\ push', 'git push'],
  ])('names the publication in %s', (command, what) => {
    expect(publicationCommandIn(command)).toBe(what);
  });

  it.each([
    'git status', 'git diff --stat', 'git log --oneline -5', 'gh pr view 533 --json body', 'gh pr list',
    'gh api repos/o/r/issues/1', 'pytest -q', 'python -m pytest tests/test_git_push_helpers.py',
  ])('leaves %s alone', (command) => {
    expect(publicationCommandIn(command)).toBeNull();
  });

  it('tells the model who publishes', () => {
    expect(publicationFenceMessage('git push')).toMatch(/^PUBLICATION_FENCED: git push/);
    expect(publicationFenceMessage('git push')).toContain('The harness commits, pushes');
  });
});

describe('bash tool under the fence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openswarm-pub-fence-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const call = (command: string): ToolCall => ({ id: 'tc', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } });

  it('refuses git push in a fenced run before running anything, and still runs ordinary commands', async () => {
    const fenced = await executeTool(call('echo started && git push origin HEAD'), dir, undefined, { forbidPublication: true });
    expect(fenced.is_error).toBe(true);
    expect(fenced.content).toMatch(/^PUBLICATION_FENCED: git push/);
    expect(fenced.content).not.toContain('started');
    const ordinary = await executeTool(call('echo fine'), dir, undefined, { forbidPublication: true });
    expect(ordinary.is_error).toBe(false);
    expect(ordinary.content).toContain('fine');
  });

  it('does not fence a run that did not ask for it', async () => {
    const result = await executeTool(call('echo "git push"'), dir, undefined, {});
    expect(result.is_error).toBe(false);
  });
});
