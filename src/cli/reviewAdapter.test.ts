// Precedence is the whole behaviour here, and it was previously unobservable:
// `openswarm review` read the config file for Linear and nothing else, so the
// reviewer ran on the registry default no matter what an operator configured
// (AGT-4292). These pin the order, and pin that a typo fails loudly instead of
// quietly selecting a different provider.

import { describe, expect, it } from 'vitest';

import { ADAPTER_NAMES } from '../core/adapterNames.js';
import { resolveReviewAdapter } from './reviewAdapter.js';

const known = (name: string) => ['codex', 'codex-responses', 'openrouter', 'claude'].includes(name);

describe('resolveReviewAdapter', () => {
  it('prefers the flag over everything else', () => {
    expect(resolveReviewAdapter({
      flag: 'openrouter', env: 'claude', configReview: 'codex', configDefault: 'codex-responses',
    }, known)).toEqual({ name: 'openrouter', source: 'flag' });
  });

  it('falls to the environment when there is no flag', () => {
    expect(resolveReviewAdapter({
      env: 'openrouter', configReview: 'codex', configDefault: 'codex-responses',
    }, known)).toEqual({ name: 'openrouter', source: 'env' });
  });

  it('prefers reviewAdapter over adapter, so review can differ from the rest', () => {
    // The point of the key: a second opinion on the same provider as the work
    // it checks is a correlated failure.
    expect(resolveReviewAdapter({
      configReview: 'openrouter', configDefault: 'codex-responses',
    }, known)).toEqual({ name: 'openrouter', source: 'config.reviewAdapter' });
  });

  it('follows the installation adapter when review is not pinned', () => {
    expect(resolveReviewAdapter({ configDefault: 'codex-responses' }, known))
      .toEqual({ name: 'codex-responses', source: 'config.adapter' });
  });

  it('leaves the registry default alone when nothing is configured', () => {
    // Undefined, not a guessed name: the caller passes this straight to
    // `getAdapter`, whose own default is the correct fallback.
    expect(resolveReviewAdapter({}, known)).toEqual({ source: 'built-in default' });
  });

  it('ignores blank and whitespace-only values instead of treating them as a choice', () => {
    // An unset shell variable arrives as '' — that must not outrank config.
    expect(resolveReviewAdapter({ env: '', configDefault: 'codex' }, known))
      .toEqual({ name: 'codex', source: 'config.adapter' });
    expect(resolveReviewAdapter({ env: '   ', configDefault: 'codex' }, known))
      .toEqual({ name: 'codex', source: 'config.adapter' });
  });

  it('trims a value rather than rejecting it', () => {
    expect(resolveReviewAdapter({ flag: ' openrouter ' }, known))
      .toEqual({ name: 'openrouter', source: 'flag' });
  });

  it('refuses an unknown name instead of silently using a lower-precedence one', () => {
    // The dangerous case: a typo in the flag would otherwise fall through to
    // config and run the review on a provider the operator did not ask for,
    // with nothing on screen to say so.
    expect(() => resolveReviewAdapter({ flag: 'openrouterr', configDefault: 'codex' }, known))
      .toThrow(/openrouterr.*flag/);
    expect(() => resolveReviewAdapter({ configReview: 'nope' }, known))
      .toThrow(/config\.reviewAdapter/);
  });
});

describe('ADAPTER_NAMES stays in step with the real registry', () => {
  it('lists exactly the adapters the registry has', async () => {
    // `adapterNames.ts` is a copy of the registry's key set, kept separate
    // because importing the registry for a string check pulls in `codex.ts`'s
    // module-scope `promisify(execFile)` and breaks every test that mocks
    // `node:child_process`. Nothing in the source links the two lists, so this
    // is the link: drift otherwise surfaces only at runtime, as a config that
    // fails Zod validation for an adapter the registry supports, or as
    // `--adapter <newname>` throwing "Unknown review adapter" for a name that
    // would have worked.
    //
    // This file does not mock `node:child_process`, so it is one of the few
    // places the registry can be imported without paying that cost.
    const { listAdapterNames } = await import('../adapters/index.js');
    expect([...listAdapterNames()].sort()).toEqual([...ADAPTER_NAMES].sort());
  });
});
