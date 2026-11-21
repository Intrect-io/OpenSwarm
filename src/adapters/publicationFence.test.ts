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

  it('refuses a PR merge verb after a -R or --repo flag', () => {
    // AGT-4414: the repo flag between `pr` and the verb hid the merge from the fence.
    for (const command of [
      'gh pr -R o/r merge 7', 'gh pr --repo o/r merge 7', 'gh pr --repo=o/r merge 7', 'gh pr -Ro/r merge 7',
      'gh pr --repo "o/r" merge 7 --squash', 'cd x && gh pr -R o/r merge 7',
    ]) {
      expect(publicationCommandIn(command), command).toBe('gh pr');
    }
    for (const verb of ['create', 'ready', 'close', 'edit', 'review', 'comment', 'checkout']) {
      expect(publicationCommandIn(`gh pr -R o/r ${verb} 7`), verb).toBe('gh pr');
      expect(publicationCommandIn(`gh pr --repo o/r ${verb} 7`), verb).toBe('gh pr');
      expect(publicationCommandIn(`gh pr --repo=o/r ${verb} 7`), verb).toBe('gh pr');
    }
  });

  it('refuses a GraphQL mergePullRequest mutation through gh api', () => {
    const mutations = [
      `gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:"PR_1"}) { clientMutationId } }'`,
      `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input:{pullRequestId:"PR_1"}) { clientMutationId } }'`,
      `gh api graphql -f query='mutation { mergeBranch(input:{repositoryId:"R_1",base:"main",head:"x"}) { clientMutationId } }'`,
      // The query may come from a variable or span lines.
      `Q='mutation { mergePullRequest(input:{pullRequestId:"PR_1"}) { clientMutationId } }'; gh api graphql -f query="$Q"`,
      "gh api graphql -f query='mutation {\n  mergePullRequest(input:{pullRequestId:\"PR_1\"}) { clientMutationId }\n}'",
    ];
    for (const command of mutations) {
      expect(publicationCommandIn(command), command).toBe('gh api graphql merge mutation');
    }
  });

  it('refuses the branch-merge endpoint gh api repos/o/r/merges', () => {
    expect(publicationCommandIn('gh api repos/o/r/merges -f base=main -f head=x')).toBe('gh api …/merges');
    expect(publicationCommandIn('gh api -X POST repos/o/r/merges -f base=main -f head=x')).toBe('gh api …/merges');
    expect(publicationCommandIn('gh api -X POST /repos/o/r/merges -f base=main -f head=x')).toBe('gh api …/merges');
  });

  it('refuses a gh alias and ANSI-C quoting that would hide a publication verb', () => {
    expect(publicationCommandIn(`gh alias set m 'pr merge'`)).toBe('gh alias');
    expect(publicationCommandIn('gh alias import aliases.yml')).toBe('gh alias');
    expect(publicationCommandIn(`gh pr $'merge' 7`)).toBe('gh pr');
    expect(publicationCommandIn('gh alias list')).toBeNull();
  });

  it.each([
    'gh pr view 7 -R o/r --json mergeable,state',
    'gh pr -R o/r view 7',
    'gh pr list --repo o/r --search is:merged',
    'gh pr checks 7',
    'gh api repos/o/r/commits/abc/check-runs',
    `gh api graphql -f query='query { repository(owner:"o",name:"r"){ pullRequest(number:7){ mergeable } } }'`,
    'git merge --abort',
    'git log --merges',
    'gh pr -R o/r view 7 | grep merge',
    'gh pr --repo o/r diff 7; echo merge',
    'gh api repos/o/r/branches/merge-queue',
    'gh api repos/o/r/commits/merge-fix/check-runs',
  ])('keeps the read-only form %s allowed', (command) => {
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

  it('refuses gh pr merge in a worker stage', async () => {
    // AGT-4414: merging is publication too; a worker stage must not land its own PR.
    expect(publicationCommandIn('gh pr merge 5')).toBe('gh pr');
    const fenced = await executeTool(call('echo started && gh pr merge 5 --squash'), dir, undefined, { forbidPublication: true });
    expect(fenced.is_error).toBe(true);
    expect(fenced.content).toMatch(/^PUBLICATION_FENCED: gh pr/);
    expect(fenced.content).not.toContain('started');
  });

  it('does not fence a run that did not ask for it', async () => {
    const result = await executeTool(call('echo "git push"'), dir, undefined, {});
    expect(result.is_error).toBe(false);
  });
});
