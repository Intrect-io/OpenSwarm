// Auto-follow for a growing stream (§2.3): stay pinned while the reader is at
// the bottom, release the moment they scroll up to read, and offer one button
// to come back. New arrivals while released are announced once per batch to
// assistive tech — never one utterance per line. (AGT-4201)

/**
 * Whether the pane is close enough to the bottom to keep following. 80px of
 * slack absorbs the jitter of a line landing mid-scroll without treating a
 * deliberate scroll-up as "still at the bottom".
 */
export function isNearBottom({ scrollHeight, scrollTop, clientHeight }, slack = 80) {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

export function createScrollFollow(pane, { button = null, liveRegion = null } = {}) {
  if (!pane) {
    return { get stick() { return true; }, follow() {}, announce() {}, stop() {} };
  }
  let stick = true;
  let unseen = 0;

  const paintButton = () => {
    if (!button) return;
    button.hidden = stick;
    if (!stick && unseen > 0) button.textContent = `↓ ${unseen} new`;
    else if (!stick) button.textContent = '↓ Latest';
  };

  const jumpToLatest = () => {
    pane.scrollTop = pane.scrollHeight;
    stick = true;
    unseen = 0;
    paintButton();
  };

  const onScroll = () => {
    const near = isNearBottom(pane);
    if (near && !stick) unseen = 0;
    stick = near;
    paintButton();
  };

  pane.addEventListener('scroll', onScroll);
  button?.addEventListener('click', jumpToLatest);
  paintButton();

  return {
    get stick() { return stick; },
    /** Call after content changed: keeps the pin if it was set. */
    follow() {
      if (stick) pane.scrollTop = pane.scrollHeight;
      paintButton();
    },
    /** Announce a batch of arrivals; counts unseen ones for the button. */
    announce(count) {
      if (!(count > 0)) return;
      if (!stick) unseen += count;
      paintButton();
      if (liveRegion) liveRegion.textContent = `${count} new message${count === 1 ? '' : 's'}`;
    },
    stop() {
      pane.removeEventListener('scroll', onScroll);
      button?.removeEventListener('click', jumpToLatest);
    },
  };
}
