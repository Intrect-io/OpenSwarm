// The risk class must reach a PR that was reused instead of created (#884 review, AGT-4804).
import { describe, expect, it } from 'vitest';
import { withRiskSection } from './pullRequestReady.js';

describe('withRiskSection', () => {
  it('appends the section to a body that has none (a parked draft)', () => {
    expect(withRiskSection('Closes AX-1\n\n## Summary\nwork', '## Risk: medium\n- dependencies: `package.json`'))
      .toBe('Closes AX-1\n\n## Summary\nwork\n\n## Risk: medium\n- dependencies: `package.json`\n');
  });

  it('replaces an earlier risk section in place and keeps what follows', () => {
    const body = '## Summary\nwork\n\n## Risk: low\n3 file(s), 10 line(s); no high- or medium-risk path.\n\n## Overlap\nnone';
    expect(withRiskSection(body, '## Risk: high\n- auth/secrets: `src/auth/x.ts`'))
      .toBe('## Summary\nwork\n\n## Risk: high\n- auth/secrets: `src/auth/x.ts`\n\n## Overlap\nnone');
  });
});
