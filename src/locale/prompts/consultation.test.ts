import { describe, expect, it } from 'vitest';
import { enPrompts } from './en.js';
import { koPrompts } from './ko.js';

describe('bounded peer consultation prompts', () => {
  it.each([
    ['en', enPrompts.coordinationConsultationPrompt],
    ['ko', koPrompts.coordinationConsultationPrompt],
  ])('%s names the complete durable consultation path without unconditional fan-out', (_locale, prompt) => {
    for (const contract of [
      'coordination_peers',
      'coordination_thread_list',
      'scope="related"',
      'scope="following"',
      'coordination_publish',
      'target_task_id',
      'thread_id',
      'advice-request',
      'coordination_read',
      'advice-response',
      'coordination_thread_reply',
      'acknowledges_correlation_id',
      'coordination_history',
      'ask_human',
    ]) {
      expect(prompt, `${_locale} prompt omits ${contract}`).toContain(contract);
    }
    expect(prompt).toMatch(/최대 3|at most 3/);
    expect(prompt).toMatch(/적절한 peer가 없으면 아무 메시지도 보내지|no suitable peer, send nothing/);
    expect(prompt).toMatch(/broadcast|fan out|여러 에이전트에게 뿌리지/);
    expect(prompt).toMatch(/반복적인\s*'coordination_wait'|repeatedly call 'coordination_wait'/);
  });

  it('binds visible coordination output to the configured locale without requesting private reasoning', () => {
    expect(enPrompts.coordinationConsultationPrompt).toContain('visible to another agent or the operator in English');
    expect(koPrompts.coordinationConsultationPrompt).toContain('다른 에이전트나 운영자가 보게 되는 모든 메시지는 한국어');
    for (const prompt of [enPrompts.coordinationConsultationPrompt, koPrompts.coordinationConsultationPrompt]) {
      expect(prompt).toMatch(/private chain-of-thought|비공개 내부 추론/);
      expect(prompt).toMatch(/code identifiers|코드\s*식별자/);
    }
  });
});
