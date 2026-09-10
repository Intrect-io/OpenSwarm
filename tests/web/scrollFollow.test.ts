// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { createScrollFollow, isNearBottom } from '../../web/static/js/scrollFollow.mjs';

function pane(metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  document.body.innerHTML = `
    <div id="p"></div><button id="b" hidden></button><div id="live"></div>`;
  const el = document.getElementById('p') as HTMLDivElement;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => { metrics.scrollTop = value; },
  });
  return {
    el,
    button: document.getElementById('b') as HTMLButtonElement,
    live: document.getElementById('live') as HTMLDivElement,
    metrics,
  };
}

describe('scroll follow (AGT-4201 §2.3)', () => {
  it('treats anything within 80px of the bottom as "at the bottom"', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 720, clientHeight: 200 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 })).toBe(false);
  });

  it('pins to the bottom until the reader scrolls up, then offers a way back', () => {
    const { el, button, metrics } = pane({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    const follow = createScrollFollow(el, { button });
    expect(button.hidden).toBe(true);

    metrics.scrollHeight = 1200;
    follow.follow();
    expect(metrics.scrollTop).toBe(1200);

    metrics.scrollTop = 100;
    el.dispatchEvent(new Event('scroll'));
    expect(follow.stick).toBe(false);
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe('↓ Latest');

    metrics.scrollHeight = 1400;
    follow.follow();
    expect(metrics.scrollTop).toBe(100); // reading is not interrupted

    button.click();
    expect(metrics.scrollTop).toBe(1400);
    expect(follow.stick).toBe(true);
    expect(button.hidden).toBe(true);
    follow.stop();
  });

  it('counts unseen arrivals on the button and announces each batch once', () => {
    const { el, button, live, metrics } = pane({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    const follow = createScrollFollow(el, { button, liveRegion: live });
    el.dispatchEvent(new Event('scroll'));
    expect(follow.stick).toBe(false);

    follow.announce(3);
    expect(button.textContent).toBe('↓ 3 new');
    expect(live.textContent).toBe('3 new messages');
    follow.announce(1);
    expect(button.textContent).toBe('↓ 4 new');
    expect(live.textContent).toBe('1 new message');

    metrics.scrollTop = 800;
    el.dispatchEvent(new Event('scroll'));
    expect(button.hidden).toBe(true);
    follow.announce(2);
    expect(button.hidden).toBe(true); // pinned: nothing is unseen
    follow.stop();
  });

  it('is inert without a pane', () => {
    const follow = createScrollFollow(null);
    expect(follow.stick).toBe(true);
    follow.follow();
    follow.announce(5);
    follow.stop();
  });
});
