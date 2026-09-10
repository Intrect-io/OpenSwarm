import { describe, expect, it } from 'vitest';
import { infraFailureFingerprint } from './infraFailureCircuit.js';

describe('infraFailureFingerprint', () => {
  it('ignores what changes between attempts and keeps what identifies the cause', () => {
    const a = infraFailureFingerprint(
      "verify-security: pytest could not run inside the attested companion: [security] strict verification sandbox unavailable: ENOENT: no such file or directory, lstat '/run/openswarm-sandbox' (took 1.93s)",
    );
    const b = infraFailureFingerprint(
      "verify-security: pytest could not run inside the attested companion: [security] strict verification sandbox unavailable: ENOENT: no such file or directory, lstat '/run/openswarm-sandbox' (took 2.41s)",
    );
    expect(a).toBe(b);
    expect(a).toContain("lstat '/run/openswarm-sandbox'");
  });

  it('collapses sandbox roots and worktree ids', () => {
    const a = infraFailureFingerprint('tester: pytest infrastructure failure in /work/.openswarm-verify-base-3zSAeP/worktree/ (worktree/fa265da7-a479-45f5-8ee3-d603465d98d6)');
    const b = infraFailureFingerprint('tester: pytest infrastructure failure in /work/.openswarm-verify-base-UY8fMU/worktree/ (worktree/9241f3b4-01c5-44a1-9d3f-77ea8037df3d)');
    expect(a).toBe(b);
  });

  it('keeps different causes apart and is empty for no detail', () => {
    expect(infraFailureFingerprint('tester: openrouter timeout after 360000ms'))
      .not.toBe(infraFailureFingerprint('security-audit: CodeQL extractor missing for go'));
    expect(infraFailureFingerprint(undefined)).toBe('');
  });
});
