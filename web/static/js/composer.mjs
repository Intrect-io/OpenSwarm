// Composer behaviours (§2.1): the parts of "type a message" that every chat
// surface needs and that are easy to get subtly wrong. Each helper binds one
// behaviour to elements it is handed, so a page composes only what it has —
// the orchestration reply box and the chat room share these without sharing
// markup. (AGT-4201)

const MAX_GROW_RATIO = 0.4; // ≈ viewport 40% before the box scrolls internally

/** Grow a textarea with its content, up to a share of the viewport. */
export function autogrow(input, { win = input.ownerDocument?.defaultView } = {}) {
  if (!input || input.tagName !== 'TEXTAREA') return () => {};
  const resize = () => {
    input.style.height = 'auto';
    const max = win ? Math.floor(win.innerHeight * MAX_GROW_RATIO) : Infinity;
    const wanted = input.scrollHeight;
    input.style.height = `${Math.min(wanted, max)}px`;
    input.style.overflowY = wanted > max ? 'auto' : 'hidden';
  };
  input.addEventListener('input', resize);
  resize();
  return resize;
}

/**
 * Enter sends, Shift+Enter breaks the line, and Enter during an IME
 * composition does neither — committing a Korean/Japanese syllable must never
 * fire the message (§2.1). Native inputs already submit on Enter, so for them
 * only the composition guard applies.
 */
export function bindEnterToSubmit(input, form) {
  if (!input || !form) return;
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.isComposing || event.keyCode === 229) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey) return; // newline (textarea) — leave the default alone
    if (input.tagName !== 'TEXTAREA') return; // an <input> submits natively
    event.preventDefault();
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new (input.ownerDocument.defaultView.Event)('submit', { bubbles: true, cancelable: true }));
  });
}

/**
 * Keep an unsent draft across reloads and navigation (§2.1). Only text the
 * operator actually typed is saved — a value set by script is not a draft.
 */
export function bindDraft(input, { storage, key }) {
  if (!input || !storage || !key) return { clear() {} };
  const read = () => { try { return storage.getItem(key) ?? ''; } catch { return ''; } };
  const write = (value) => {
    try {
      if (value) storage.setItem(key, value);
      else storage.removeItem(key);
    } catch { /* storage blocked — the draft lives for this page only */ }
  };
  if (!input.value) {
    const saved = read();
    if (saved) {
      input.value = saved;
      input.dispatchEvent(new (input.ownerDocument.defaultView.Event)('input', { bubbles: true }));
    }
  }
  input.addEventListener('input', () => write(input.value));
  return { clear: () => write('') };
}

/** Send is possible only with something to send, someone to send it to, and no send in flight. */
export function canSend({ text = '', files = 0, addressable = true, sending = false }) {
  return !sending && addressable && (String(text).trim().length > 0 || files > 0);
}

/** Reflect the send affordance on the button (disabled) and the box (aria). */
export function setSendEnabled(button, state) {
  if (!button) return;
  button.disabled = !canSend(state);
}

/**
 * While a send is in flight the button becomes the in-progress indicator, in
 * the same place and size (§2.1 "same position, same size"), and says so to
 * assistive tech through aria-busy.
 */
export function setSendingState(button, sending, { idleLabel = 'Send', busyLabel = 'Sending…' } = {}) {
  if (!button) return;
  button.setAttribute('aria-busy', String(!!sending));
  button.textContent = sending ? busyLabel : idleLabel;
}
