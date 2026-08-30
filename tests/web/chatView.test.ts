// @vitest-environment jsdom
//
// The chat room is one chronological surface over every task: trace backfill,
// SSE liveness, sticky autoscroll, and a composer that must address a real
// agent or the POST is unroutable. Drive it with a faked fetch, assert DOM.

import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { startChatView, isNearBottom, renderChatText, renderLine, renderMentionText } from '../../web/static/js/chatView.mjs';

function shell(): Document {
  document.body.innerHTML = `
    <div id="room"></div>
    <form id="composer">
      <input id="composer-file" type="file" multiple hidden />
      <button type="button" id="composer-attach">📎</button>
      <input id="composer-text" type="text" />
      <button type="submit">Send</button>
    </form>
    <div id="composer-files"></div>`;
  return document;
}

function boardEvent(over: Record<string, unknown> = {}) {
  return {
    id: `id-${Math.random()}`,
    fingerprint: 'fingerprint-1',
    seq: 1,
    timestamp: Date.now(),
    correlationId: 'c1',
    repository: '/repo',
    taskId: 't1',
    taskLabel: 'AGT-1009',
    actor: 'enginseer-rhodanis-novum',
    actorName: 'Enginseer Rhodanis-Novum',
    actorRole: 'worker',
    recipient: 'adept-helion-cognitor',
    recipientName: 'Adept Helion-Cognitor',
    recipientRole: 'reviewer',
    kind: 'delegation-result',
    status: 'completed',
    summary: 'Landed the retry change.',
    ...over,
  };
}

function fetchWith(history: unknown[], board: unknown[] = [], messageResponse?: unknown) {
  return vi.fn(async (url: string) => {
    if (url.startsWith('/api/coordination/message')) {
      return messageResponse ?? { ok: true, json: async () => ({ delivered: true }) };
    }
    if (url.startsWith('/api/coordination/history')) {
      return { ok: true, json: async () => ({ events: history, traceSize: history.length }) };
    }
    return { ok: true, json: async () => ({ events: board, pending: [], lastSeq: 0 }) };
  });
}

describe('startChatView', () => {
  it('renders the trace backfill as chronological IRC lines', async () => {
    const doc = shell();
    const view = startChatView(doc, {
      fetchImpl: fetchWith([
        boardEvent({ id: 'e2', seq: 2, actor: 'adept-helion-cognitor', actorName: 'Adept Helion-Cognitor', actorRole: 'reviewer', recipient: 'enginseer-rhodanis-novum', recipientName: 'Enginseer Rhodanis-Novum', recipientRole: 'worker', kind: 'advice-response', detail: 'Approved: the retry belongs in the scheduler.' }),
        boardEvent({ id: 'e1', seq: 1 }),
      ]),
      eventSourceImpl: null,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(2));

    const lines = [...doc.querySelectorAll('#room .line')];
    // Oldest first, like a room transcript.
    expect(lines[0].querySelector('.who')!.textContent).toBe('Enginseer Rhodanis-Novum');
    expect(lines[0].querySelector('.tag')!.textContent).toBe('(worker · AGT-1009)');
    expect(lines[0].querySelector('.clock')!.textContent).toMatch(/^\[.+\]$/);
    expect(lines[0].querySelector('.text')!.textContent).toBe('Landed the retry change.');
    // The reply prefers its long form and names its addressee.
    expect(lines[1].querySelector('.text')!.textContent).toBe('Approved: the retry belongs in the scheduler.');
    expect(lines[1].querySelector('.to')!.textContent).toBe("→ @'Enginseer Rhodanis-Novum'");
    view.stop();
  });

  it('merges history and board snapshots without duplicating an event', async () => {
    const doc = shell();
    const shared = boardEvent({ id: 'same' });
    const view = startChatView(doc, {
      fetchImpl: fetchWith([shared], [shared, boardEvent({ id: 'board-only', seq: 2 })]),
      eventSourceImpl: null,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(2));
    view.stop();
  });

  it('keeps instruction snapshots out of the room', async () => {
    const doc = shell();
    const view = startChatView(doc, {
      fetchImpl: fetchWith([
        boardEvent({ id: 'snap', kind: 'instruction-snapshot', summary: 'Claude Code rules abc (0 sources)' }),
        boardEvent({ id: 'talk', seq: 2 }),
      ]),
      eventSourceImpl: null,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));
    expect(doc.getElementById('room')!.textContent).not.toContain('rules abc');
    view.stop();
  });

  it('appends a live SSE utterance to the room', async () => {
    const doc = shell();
    const listeners: { onmessage?: (msg: { data: string }) => void } = {};
    class FakeSource {
      set onmessage(fn: (msg: { data: string }) => void) { listeners.onmessage = fn; }
      close(): void { /* noop */ }
    }
    const view = startChatView(doc, {
      fetchImpl: fetchWith([boardEvent({ id: 'e1' })]),
      eventSourceImpl: FakeSource,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    listeners.onmessage!({
      data: JSON.stringify({
        type: 'coordination:event',
        data: boardEvent({ id: 'live', seq: 9, summary: 'Now reviewing the diff.' }),
      }),
    });
    expect(doc.querySelectorAll('#room .line').length).toBe(2);
    expect(doc.getElementById('room')!.textContent).toContain('Now reviewing the diff.');
    view.stop();
  });

  it('replaces an existing line when its Korean projection arrives', async () => {
    const doc = shell();
    const listeners: { onmessage?: (msg: { data: string }) => void } = {};
    class FakeSource {
      set onmessage(fn: (msg: { data: string }) => void) { listeners.onmessage = fn; }
      close(): void { /* noop */ }
    }
    const original = boardEvent({ id: 'localized-later', summary: 'Mention Operator after review.' });
    const view = startChatView(doc, { fetchImpl: fetchWith([original]), eventSourceImpl: FakeSource });
    await vi.waitFor(() => expect(doc.getElementById('room')!.textContent).toContain("Mention @'Operator' after review."));

    listeners.onmessage!({
      data: JSON.stringify({
        type: 'coordination:event',
        data: { ...original, summary: '검토 후 Operator에게 알려 주세요.', localizedLocale: 'ko', originalText: { summary: original.summary } },
      }),
    });
    expect(doc.querySelectorAll('#room .line')).toHaveLength(1);
    expect(doc.getElementById('room')!.textContent).toContain("검토 후 @'Operator'에게 알려 주세요.");

    listeners.onmessage!({ data: JSON.stringify({ type: 'coordination:event', data: original }) });
    expect(doc.getElementById('room')!.textContent).toContain("검토 후 @'Operator'에게 알려 주세요.");
    view.stop();
  });

  it('sets operator lines apart from agent speech', async () => {
    const doc = shell();
    const view = startChatView(doc, {
      fetchImpl: fetchWith([
        boardEvent({ id: 'a' }),
        boardEvent({ id: 'op', seq: 2, actor: 'operator-dashboard', actorName: 'Operator', actorRole: 'human', kind: 'advice-response', summary: 'Ship it.' }),
      ]),
      eventSourceImpl: null,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(2));
    expect(doc.querySelectorAll('#room .line.from-operator').length).toBe(1);
    expect(doc.querySelector('#room .line.from-operator .who')!.textContent).toBe('Operator');
    view.stop();
  });

  it('POSTs the composer text addressed to the newest agent speaker', async () => {
    const doc = shell();
    const fetchImpl = fetchWith([
      boardEvent({ id: 'a', seq: 1 }),
      boardEvent({ id: 'b', seq: 2, actor: 'adept-helion-cognitor', actorName: 'Adept Helion-Cognitor', actorRole: 'reviewer', correlationId: 'c9', repository: '/other-repo', taskId: 't9' }),
    ]);
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(2));

    const input = doc.getElementById('composer-text') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe('Message Adept Helion-Cognitor…');
    input.value = 'Hold the merge until CI is green.';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(fetchImpl.mock.calls.some((call) => call[0] === '/api/coordination/message')).toBe(true));
    const [, init] = fetchImpl.mock.calls.find((call) => call[0] === '/api/coordination/message')!;
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      correlationId: 'c9',
      recipient: 'adept-helion-cognitor',
      repository: '/other-repo',
      taskId: 't9',
      text: 'Hold the merge until CI is green.',
    });
    view.stop();
  });

  it('disables the composer while nobody can be addressed', async () => {
    const doc = shell();
    const view = startChatView(doc, { fetchImpl: fetchWith([]), eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.getElementById('room')!.textContent).toContain('No one has said anything yet.'));
    expect((doc.getElementById('composer-text') as HTMLInputElement).disabled).toBe(true);
    expect((doc.querySelector('#composer button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    view.stop();
  });

  it('escapes hostile words instead of injecting them into the room', async () => {
    const doc = shell();
    const view = startChatView(doc, {
      fetchImpl: fetchWith([boardEvent({ id: 'x', detail: '<img src=x onerror=alert(1)>', taskLabel: '<script>alert(1)</script>' })]),
      eventSourceImpl: null,
    });
    await vi.waitFor(() => expect(doc.getElementById('room')!.textContent).toContain('<img'));
    expect(doc.getElementById('room')!.querySelector('img')).toBeNull();
    expect(doc.getElementById('room')!.querySelector('script')).toBeNull();
    view.stop();
  });

  it('stays pinned to the bottom until the operator scrolls up, then releases', async () => {
    const doc = shell();
    const listeners: { onmessage?: (msg: { data: string }) => void } = {};
    class FakeSource {
      set onmessage(fn: (msg: { data: string }) => void) { listeners.onmessage = fn; }
      close(): void { /* noop */ }
    }
    const view = startChatView(doc, {
      fetchImpl: fetchWith([boardEvent({ id: 'e1' })]),
      eventSourceImpl: FakeSource,
    });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    // jsdom has no layout, so give the room real-looking scroll metrics.
    const room = doc.getElementById('room')!;
    Object.defineProperty(room, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(room, 'clientHeight', { configurable: true, value: 200 });

    // Reading scrollback: far from the bottom, a new line must not yank the view.
    room.scrollTop = 100;
    room.dispatchEvent(new window.Event('scroll'));
    listeners.onmessage!({ data: JSON.stringify({ type: 'coordination:event', data: boardEvent({ id: 'l1', seq: 2 }) }) });
    expect(room.scrollTop).toBe(100);

    // Back near the bottom: the pin re-engages on the next line.
    room.scrollTop = 790;
    room.dispatchEvent(new window.Event('scroll'));
    listeners.onmessage!({ data: JSON.stringify({ type: 'coordination:event', data: boardEvent({ id: 'l2', seq: 3 }) }) });
    expect(room.scrollTop).toBe(1000);
    view.stop();
  });
});

describe('isNearBottom', () => {
  it('is true at the bottom and within the slack band', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 770, clientHeight: 200 })).toBe(true);
  });

  it('is false once the reader has scrolled meaningfully up', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 200 })).toBe(false);
  });
});

describe('renderLine', () => {
  it('drops the tag when there is neither role nor task', () => {
    const html = renderLine({
      id: 'x', seq: 1, timestamp: 0, speakerName: 'Ghost', role: '', speakerRole: '',
      recipientName: null, text: 'boo', taskLabel: '', status: 'completed', kind: 'advice-request', isOperator: false,
    });
    expect(html).not.toContain('class="tag"');
    expect(html).toContain('boo');
  });

  it('canonicalizes agent and operator mentions without double-prefixing existing mentions', () => {
    const html = renderMentionText(
      "Ask QuarryMaker7826, then notify @'Operator' and @QuarryMaker7826.",
      [{ name: 'QuarryMaker7826', role: 'worker' }, { name: 'Operator', role: 'human' }],
    );
    document.body.innerHTML = html;
    const mentions = [...document.querySelectorAll('.mention')];
    expect(mentions.map((mention) => mention.textContent)).toEqual([
      "@'QuarryMaker7826'", "@'Operator'", "@'QuarryMaker7826'",
    ]);
    expect(mentions[1].classList.contains('mention-human')).toBe(true);
    expect(document.body.textContent).not.toContain("@@'");
  });

  it('does not highlight names inside ASCII identifiers but accepts Korean particles', () => {
    const html = renderMentionText(
      'Sablewood is not Sable, but Sable에게 답하세요.',
      [{ name: 'Sable', role: 'worker' }],
    );
    document.body.innerHTML = html;
    expect(document.body.textContent).toBe("Sablewood is not @'Sable', but @'Sable'에게 답하세요.");
    expect(document.querySelectorAll('.mention')).toHaveLength(2);
  });

  it('highlights a recipient as a canonical mention and escapes untrusted prose', () => {
    const html = renderLine({
      id: 'x', seq: 1, timestamp: 0, speakerName: 'Worker', role: 'worker', speakerRole: 'worker',
      recipientName: 'Operator', recipientRole: 'human', text: '<script>bad()</script>',
      taskLabel: 'AGT-1', status: 'completed', kind: 'advice-request', isOperator: false,
    }, [{ name: 'Operator', role: 'human' }]);
    document.body.innerHTML = html;
    expect(document.querySelector('.to .mention')?.textContent).toBe("@'Operator'");
    expect(document.querySelector('.to .mention')?.classList.contains('mention-human')).toBe(true);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('.text')?.textContent).toBe('<script>bad()</script>');
  });

  it('renders backtick spans as escaped code chips and leaves mentions outside them highlighted', () => {
    const html = renderChatText(
      "Tell Operator to inspect `<img src=x onerror=alert(1)>` in `web/router.ts`.",
      [{ name: 'Operator', role: 'human' }],
    );
    document.body.innerHTML = html;
    expect(document.querySelector('.mention')?.textContent).toBe("@'Operator'");
    expect([...document.querySelectorAll('code')].map((node) => node.textContent)).toEqual([
      '<img src=x onerror=alert(1)>', 'web/router.ts',
    ]);
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('startChatView composer outcome (AGT-4026)', () => {
  // `fetch` resolves on 400/409, so a refused send used to look identical to a
  // delivered one — the operator's text was already gone from the box and
  // nothing said why. Nine agents were parked awaiting an answer when this was
  // reported.
  it('keeps the text and shows the daemon\'s reason when the send is refused', async () => {
    const doc = shell();
    const fetchImpl = fetchWith(
      [boardEvent({ id: 'a', seq: 1 })],
      [],
      { ok: false, status: 409, json: async () => ({ error: 'Question is already completed' }) },
    );
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    const input = doc.getElementById('composer-text') as HTMLInputElement;
    input.value = 'Use the masked card master.';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(doc.getElementById('composer-status')?.textContent).toBe('Question is already completed');
    });
    expect(input.value).toBe('Use the masked card master.');
    view.stop();
  });

  it('clears the box only after the daemon accepts', async () => {
    const doc = shell();
    const fetchImpl = fetchWith([boardEvent({ id: 'a', seq: 1 })]);
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    const input = doc.getElementById('composer-text') as HTMLInputElement;
    input.value = 'Proceed with the mounted credentials.';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(input.value).toBe(''));
    expect(doc.getElementById('composer-status')?.textContent).toBe('');
    view.stop();
  });

  it('reports an unreachable daemon instead of swallowing it', async () => {
    const doc = shell();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('/api/coordination/message')) throw new Error('network down');
      if (url.startsWith('/api/coordination/history')) {
        return { ok: true, json: async () => ({ events: [boardEvent({ id: 'a', seq: 1 })], traceSize: 1 }) };
      }
      return { ok: true, json: async () => ({ events: [], pending: [], lastSeq: 0 }) };
    });
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    const input = doc.getElementById('composer-text') as HTMLInputElement;
    input.value = 'anyone there?';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(doc.getElementById('composer-status')?.textContent).toContain('network down');
    });
    expect(input.value).toBe('anyone there?');
    view.stop();
  });
});

describe('answering a parked agent from chat (AGT-4030)', () => {
  // Ten agents sat on human-question with no way to answer them: the composer
  // addressed the newest stage exchange, so the daemon filed the reply as a
  // note and nothing unparked.
  const parked = () => [
    boardEvent({ id: 'stage', seq: 9, correlationId: 'stage:abc:worker:2', actor: 'sable', actorName: 'Sable' }),
    boardEvent({
      id: 'q', seq: 10, kind: 'human-question', status: 'waiting',
      correlationId: 'hq-9', repository: '/work/repo', taskId: 'task-9',
      actor: 'sable', actorName: 'Sable', actorRole: 'worker',
      recipient: 'human', recipientName: 'Operator', recipientRole: 'human',
      summary: 'uv is missing — install it or run elsewhere?',
    }),
  ];

  it('sends on the question\'s exchange, not the newest one', async () => {
    const doc = shell();
    const fetchImpl = fetchWith(parked());
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(2));

    const input = doc.getElementById('composer-text') as HTMLInputElement;
    input.value = 'uv is installed now — retry.';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(fetchImpl.mock.calls.some((c) => c[0] === '/api/coordination/message')).toBe(true));
    const [, init] = fetchImpl.mock.calls.find((c) => c[0] === '/api/coordination/message')!;
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      correlationId: 'hq-9',
      recipient: 'sable',
      repository: '/work/repo',
      taskId: 'task-9',
      text: 'uv is installed now — retry.',
    });
    view.stop();
  });

  it('says it is answering, and what', async () => {
    const doc = shell();
    const view = startChatView(doc, { fetchImpl: fetchWith(parked()), eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(2));

    const input = doc.getElementById('composer-text') as HTMLInputElement;
    expect(input.placeholder).toContain('Answer Sable');
    expect(input.placeholder).toContain('uv is missing');
    view.stop();
  });

  it('still just talks when nobody is waiting on an answer', async () => {
    const doc = shell();
    const fetchImpl = fetchWith([boardEvent({ id: 'a', seq: 1, correlationId: 'c-plain' })]);
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    const input = doc.getElementById('composer-text') as HTMLInputElement;
    expect(input.placeholder).toContain('Message ');
    input.value = 'just chatting';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(fetchImpl.mock.calls.some((c) => c[0] === '/api/coordination/message')).toBe(true));
    const [, init] = fetchImpl.mock.calls.find((c) => c[0] === '/api/coordination/message')!;
    expect(JSON.parse((init as { body: string }).body).correlationId).toBe('c-plain');
    view.stop();
  });
});

describe('chat attachments (AGT-4031)', () => {
  // Handing an agent a file used to mean placing it on the host by hand and
  // describing the path in prose. The message must carry paths that already
  // exist, or the agent reads it and finds nothing there.
  function fetchWithUpload(stored: unknown, uploadOk = true) {
    return vi.fn(async (url: string) => {
      if (url.startsWith('/api/coordination/attachment')) {
        return uploadOk
          ? { ok: true, json: async () => stored }
          : { ok: false, status: 413, json: async () => ({ error: 'Attachment exceeds 67108864 bytes' }) };
      }
      if (url.startsWith('/api/coordination/message')) return { ok: true, json: async () => ({ delivered: true }) };
      if (url.startsWith('/api/coordination/history')) {
        return { ok: true, json: async () => ({ events: [boardEvent({ id: 'a', seq: 1 })], traceSize: 1 }) };
      }
      return { ok: true, json: async () => ({ events: [], pending: [], lastSeq: 0 }) };
    });
  }

  const dropFile = (doc: Document, file: File) => {
    const dropEvent = new window.Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(dropEvent, 'dataTransfer', { value: { files: [file] } });
    doc.getElementById('room')!.dispatchEvent(dropEvent);
  };

  it('uploads a dropped file and tells the agent where to read it', async () => {
    const doc = shell();
    const fetchImpl = fetchWithUpload({
      id: 'abc.csv', filename: 'A2-bank.csv', bytes: 21,
      path: '/home/openswarm/.openswarm/attachments/t1/abc.csv',
    });
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    dropFile(doc, new File(['rows'], 'A2-bank.csv', { type: 'text/csv' }));
    await vi.waitFor(() => expect(doc.querySelectorAll('#composer-files .chip').length).toBe(1));

    (doc.getElementById('composer-text') as HTMLInputElement).value = 'Here is the export.';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(fetchImpl.mock.calls.some((c) => c[0] === '/api/coordination/message')).toBe(true));
    const [uploadUrl, uploadInit] = fetchImpl.mock.calls.find((c) => String(c[0]).startsWith('/api/coordination/attachment'))!;
    expect(String(uploadUrl)).toContain('filename=A2-bank.csv');
    expect((uploadInit as RequestInit).method).toBe('POST');

    const [, init] = fetchImpl.mock.calls.find((c) => c[0] === '/api/coordination/message')!;
    const sent = JSON.parse((init as { body: string }).body).text;
    expect(sent).toContain('Here is the export.');
    expect(sent).toContain('/home/openswarm/.openswarm/attachments/t1/abc.csv');
    // Staged files are cleared only after the send is accepted.
    expect(doc.querySelectorAll('#composer-files .chip').length).toBe(0);
    view.stop();
  });

  it('reuses an upload that already landed when the publish is retried', async () => {
    // Uploads happen one at a time and the message naming them is published
    // last, so a refusal there leaves the bytes on disk. Re-uploading on the
    // retry would duplicate them, and the duplicates count against the store's
    // ceiling — making the retry likelier to fail than the attempt before it.
    const doc = shell();
    let publishAccepts = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/coordination/attachment')) {
        return { ok: true, json: async () => ({ id: 'i', filename: 'a.csv', bytes: 4, path: '/p/a.csv' }) };
      }
      if (String(url).startsWith('/api/coordination/message')) {
        return publishAccepts
          ? { ok: true, json: async () => ({ delivered: true }) }
          : { ok: false, status: 400, json: async () => ({ error: 'Cannot address the message' }) };
      }
      if (String(url).startsWith('/api/coordination/history')) {
        return { ok: true, json: async () => ({ events: [boardEvent({ id: 'a', seq: 1 })], traceSize: 1 }) };
      }
      return { ok: true, json: async () => ({ events: [], pending: [], lastSeq: 0 }) };
    });
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    dropFile(doc, new File(['rows'], 'a.csv', { type: 'text/csv' }));
    await vi.waitFor(() => expect(doc.querySelectorAll('#composer-files .chip').length).toBe(1));

    const submit = () => doc.getElementById('composer')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    (doc.getElementById('composer-text') as HTMLInputElement).value = 'here it is';
    submit();
    await vi.waitFor(() => expect(doc.getElementById('composer-status')?.textContent).toContain('Cannot address'));

    publishAccepts = true;
    submit();
    await vi.waitFor(() => expect(doc.querySelectorAll('#composer-files .chip').length).toBe(0));

    const uploads = fetchImpl.mock.calls.filter((c) => String(c[0]).startsWith('/api/coordination/attachment'));
    expect(uploads).toHaveLength(1);
    // Reuse is scoped to the task it landed under: a path carrying one task must
    // never ride a message addressed to another.
    expect(String(uploads[0][0])).toContain('taskId=t1');
    // The retried message still carries the path from that one upload.
    const publishes = fetchImpl.mock.calls.filter((c) => String(c[0]).startsWith('/api/coordination/message'));
    expect(JSON.parse((publishes.at(-1)![1] as { body: string }).body).text).toContain('/p/a.csv');
    view.stop();
  });

  it('keeps the file staged and says why when the upload is refused', async () => {
    const doc = shell();
    const fetchImpl = fetchWithUpload(null, false);
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    dropFile(doc, new File(['x'], 'huge.bin'));
    await vi.waitFor(() => expect(doc.querySelectorAll('#composer-files .chip').length).toBe(1));

    (doc.getElementById('composer-text') as HTMLInputElement).value = 'take this';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(doc.getElementById('composer-status')?.textContent).toContain('exceeds');
    });
    // Nothing was published, and neither the words nor the file were thrown away.
    expect(fetchImpl.mock.calls.some((c) => c[0] === '/api/coordination/message')).toBe(false);
    expect((doc.getElementById('composer-text') as HTMLInputElement).value).toBe('take this');
    expect(doc.querySelectorAll('#composer-files .chip').length).toBe(1);
    view.stop();
  });

  it('keeps a file staged mid-send instead of clearing it with the sent one', async () => {
    // A publish takes seconds under load, and the operator keeps working.
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const doc = shell();
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/coordination/attachment')) {
        return { ok: true, json: async () => ({ id: 'i', filename: 'first.txt', bytes: 1, path: '/p/first.txt' }) };
      }
      if (String(url).startsWith('/api/coordination/message')) {
        await gate;
        return { ok: true, json: async () => ({ delivered: true }) };
      }
      if (String(url).startsWith('/api/coordination/history')) {
        return { ok: true, json: async () => ({ events: [boardEvent({ id: 'a', seq: 1 })], traceSize: 1 }) };
      }
      return { ok: true, json: async () => ({ events: [], pending: [], lastSeq: 0 }) };
    });
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    dropFile(doc, new File(['1'], 'first.txt'));
    await vi.waitFor(() => expect(doc.querySelectorAll('#composer-files .chip').length).toBe(1));
    (doc.getElementById('composer-text') as HTMLInputElement).value = 'first';
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    // Staged while the send is still in flight.
    await vi.waitFor(() => expect(doc.getElementById('composer-status')?.textContent).toBe('Sending…'));
    dropFile(doc, new File(['2'], 'second.txt'));
    release(null);

    await vi.waitFor(() => expect(doc.getElementById('composer-status')?.textContent).toBe(''));
    const chips = [...doc.querySelectorAll('#composer-files .chip')].map((c) => c.textContent ?? '');
    expect(chips.some((text) => text.includes('second.txt'))).toBe(true);
    expect(chips.some((text) => text.includes('first.txt'))).toBe(false);
    view.stop();
  });

  it('lets a file be sent with no words at all', async () => {
    const doc = shell();
    const fetchImpl = fetchWithUpload({ id: 'i', filename: 'note.txt', bytes: 2, path: '/p/note.txt' });
    const view = startChatView(doc, { fetchImpl, eventSourceImpl: null });
    await vi.waitFor(() => expect(doc.querySelectorAll('#room .line').length).toBe(1));

    dropFile(doc, new File(['hi'], 'note.txt'));
    await vi.waitFor(() => expect(doc.querySelectorAll('#composer-files .chip').length).toBe(1));
    doc.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(fetchImpl.mock.calls.some((c) => c[0] === '/api/coordination/message')).toBe(true));
    view.stop();
  });
});
