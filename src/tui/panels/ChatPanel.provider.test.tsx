// Purpose: /provider interactive switcher + direct switch (INT-1960)
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ChatPanel } from './ChatPanel.js';

const tick = () => new Promise((r) => setTimeout(r, 60));

describe('ChatPanel /provider (INT-1960)', () => {
  it('switches provider directly with /provider <name>', async () => {
    const { stdin, lastFrame } = render(<ChatPanel active />);
    stdin.write('/provider gpt');
    await tick();
    stdin.write('\r'); // no palette (has a space) → submit
    await tick();
    expect(lastFrame()).toContain('Provider → gpt');
  });

  it('switches to claude with the claude default model, not a Codex id (INT-3284)', async () => {
    const { stdin, lastFrame } = render(<ChatPanel active />);
    stdin.write('/provider claude');
    await tick();
    stdin.write('\r');
    await tick();
    expect(lastFrame()).toContain('Provider → claude (model: sonnet)');
    expect(lastFrame()).not.toContain('gpt-5-codex');
  });

  it('opens an interactive selector on bare /provider', async () => {
    const { stdin, lastFrame } = render(<ChatPanel active />);
    stdin.write('/provider');
    await tick();
    stdin.write('\r'); // palette select runs /provider → selector opens
    await tick();
    expect(lastFrame()).toContain('Switch provider:');
  });

  it('rejects an unknown provider', async () => {
    const { stdin, lastFrame } = render(<ChatPanel active />);
    stdin.write('/provider nope-xyz');
    await tick();
    stdin.write('\r');
    await tick();
    expect(lastFrame()).toContain('Unknown provider');
  });
});
