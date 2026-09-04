// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  autogrow, bindDraft, bindEnterToSubmit, canSend, setSendEnabled, setSendingState,
  // @ts-expect-error — browser ESM asset without type declarations
} from '../../web/static/js/composer.mjs';

function shell() {
  document.body.innerHTML = `
    <form id="f"><textarea id="t"></textarea><button type="submit" id="b">Send</button></form>`;
  return {
    form: document.getElementById('f') as HTMLFormElement,
    box: document.getElementById('t') as HTMLTextAreaElement,
    button: document.getElementById('b') as HTMLButtonElement,
  };
}

function key(target: Element, init: KeyboardEventInit & { keyCode?: number }) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  target.dispatchEvent(event);
  return event;
}

describe('composer behaviours (AGT-4201 §2.1)', () => {
  it('Enter submits, Shift+Enter does not, and Enter mid-composition does nothing', () => {
    const { form, box } = shell();
    const submit = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener('submit', submit);
    bindEnterToSubmit(box, form);

    key(box, { key: 'Enter', shiftKey: true });
    expect(submit).not.toHaveBeenCalled();

    const composing = key(box, { key: 'Enter', isComposing: true });
    expect(submit).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(true);

    const legacyIme = key(box, { key: 'Enter', keyCode: 229 });
    expect(submit).not.toHaveBeenCalled();
    expect(legacyIme.defaultPrevented).toBe(true);

    key(box, { key: 'Enter' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('leaves a plain <input> to submit natively but still guards the IME commit', () => {
    document.body.innerHTML = '<form id="f"><input id="i" /></form>';
    const form = document.getElementById('f') as HTMLFormElement;
    const input = document.getElementById('i') as HTMLInputElement;
    const submit = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener('submit', submit);
    bindEnterToSubmit(input, form);
    expect(key(input, { key: 'Enter', isComposing: true }).defaultPrevented).toBe(true);
    expect(key(input, { key: 'Enter' }).defaultPrevented).toBe(false);
    expect(submit).not.toHaveBeenCalled(); // the browser, not this module, submits
  });

  it('decides Send from text, files, an addressee, and a send in flight', () => {
    expect(canSend({ text: '', files: 0 })).toBe(false);
    expect(canSend({ text: '   ', files: 0 })).toBe(false);
    expect(canSend({ text: 'hi', files: 0 })).toBe(true);
    expect(canSend({ text: '', files: 1 })).toBe(true);
    expect(canSend({ text: 'hi', addressable: false })).toBe(false);
    expect(canSend({ text: 'hi', sending: true })).toBe(false);
    const { button } = shell();
    setSendEnabled(button, { text: '' });
    expect(button.disabled).toBe(true);
    setSendEnabled(button, { text: 'go' });
    expect(button.disabled).toBe(false);
  });

  it('turns the button into the in-flight indicator in place', () => {
    const { button } = shell();
    setSendingState(button, true);
    expect(button.textContent).toBe('Sending…');
    expect(button.getAttribute('aria-busy')).toBe('true');
    setSendingState(button, false);
    expect(button.textContent).toBe('Send');
    expect(button.getAttribute('aria-busy')).toBe('false');
  });

  it('restores a typed draft, saves as the operator types, and forgets it on clear', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    store.set('draft', 'half a thought');
    const { box } = shell();
    const draft = bindDraft(box, { storage, key: 'draft' });
    expect(box.value).toBe('half a thought');

    box.value = 'half a thought, finished';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(store.get('draft')).toBe('half a thought, finished');

    draft.clear();
    expect(store.has('draft')).toBe(false);
  });

  it('does not treat a value set by script as a draft', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    const { box } = shell();
    bindDraft(box, { storage, key: 'draft' });
    box.value = 'programmatic';
    expect(store.has('draft')).toBe(false);
  });

  it('grows a textarea with its content and caps it at a share of the viewport', () => {
    const { box } = shell();
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => 120 });
    const win = { innerHeight: 1000 } as Window;
    const regrow = autogrow(box, { win });
    expect(box.style.height).toBe('120px');
    expect(box.style.overflowY).toBe('hidden');

    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => 900 });
    regrow();
    expect(box.style.height).toBe('400px');
    expect(box.style.overflowY).toBe('auto');
  });

  it('is a no-op for a plain <input>', () => {
    document.body.innerHTML = '<input id="i" />';
    const input = document.getElementById('i') as HTMLInputElement;
    const regrow = autogrow(input);
    regrow();
    expect(input.style.height).toBe('');
  });
});
