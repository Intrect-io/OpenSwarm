import { describe, expect, it } from 'vitest';
import { CursorCliAdapter, extractCursorFinalText } from './cursor.js';

describe('CursorCliAdapter', () => {
  it('runs headlessly in the selected workspace without force/yolo', () => {
    const spec = new CursorCliAdapter().buildCommand({ prompt: '/tmp/prompt', cwd: '/repo', model: 'gpt-5' });
    expect(spec).toMatchObject({ command: 'cursor-agent', stdinFile: '/tmp/prompt' });
    expect(spec.args).toContain('--print');
    expect(spec.args).toContain('stream-json');
    expect(spec.args).toContain('/repo');
    expect(spec.args).not.toContain('--force');
    expect(spec.args).not.toContain('--yolo');
  });

  it('uses ask mode plus sandbox for read-only review', () => {
    const args = new CursorCliAdapter().buildCommand({ prompt: '/tmp/p', cwd: '/repo', readOnly: true }).args;
    expect(args).toContain('ask');
    expect(args).toContain('enabled');
  });

  it('extracts the last textual stream event', () => {
    const stream = [JSON.stringify({ type: 'assistant', text: 'first' }), JSON.stringify({ type: 'result', result: 'final' })].join('\n');
    expect(extractCursorFinalText(stream)).toBe('final');
  });
});
