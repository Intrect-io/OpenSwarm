import { describe, expect, it } from 'vitest';
import { formatOpenRouterOauthInstructions } from './openrouterPkce.js';

describe('formatOpenRouterOauthInstructions', () => {
  it('prints the authorize URL and an SSH local-forward for the callback port', () => {
    const lines = formatOpenRouterOauthInstructions(
      'https://openrouter.ai/auth?callback_url=http://127.0.0.1:1456/auth/callback',
      1456,
      { USER: 'unohee' },
      'headless-box',
    );
    expect(lines.some((line) => line.includes('https://openrouter.ai/auth?'))).toBe(true);
    expect(lines).toContain('  ssh -N -L 1456:127.0.0.1:1456 unohee@headless-box');
  });
});
