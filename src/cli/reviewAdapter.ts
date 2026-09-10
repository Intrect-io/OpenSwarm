// ============================================
// OpenSwarm — which adapter reviews a change (AGT-4292)
// ============================================
//
// `openswarm review` read the config file for Linear settings and for nothing
// else, so `runReviewer` fell through to the module default — 'codex' — no
// matter what the operator had configured. The daemon honours `adapter:`; the
// standalone CLI did not, which is the CLI-vs-daemon capability gap this repo
// keeps rediscovering.
//
// Review is also the one role an operator may reasonably want to pin
// separately: it is the second opinion, so running it on the same provider as
// the work it checks is a correlated failure. `reviewAdapter` exists so that
// choice does not force the whole daemon onto another provider.
//
// Pure and separately testable: the caller needs a loaded config and a live
// adapter registry, neither of which says anything about precedence.

/** Where a review adapter can come from, most specific first. */
export interface ReviewAdapterSources {
  /** `--adapter` on the command line. */
  flag?: string;
  /** OPENSWARM_REVIEW_ADAPTER — a per-shell override that needs no config edit. */
  env?: string;
  /** `reviewAdapter:` in config — pins review without moving every other role. */
  configReview?: string;
  /** `adapter:` in config — what the rest of this installation uses. */
  configDefault?: string;
}

export interface ReviewAdapterChoice {
  /** The adapter to use, or undefined to leave the registry default in place. */
  name?: string;
  /**
   * Which source won, for the debug line.
   *
   * `config.adapter` is reported for a value that came from the config schema's
   * own default as well as one the operator typed — `AdapterNameSchema` has
   * `.default('codex')`, so `config.adapter` is truthy whenever any config file
   * parses at all. `built-in default` therefore only appears when config could
   * not be loaded. The two spellings mean the same adapter; the label is a hint
   * about where to look, not a claim about what was written.
   */
  source: 'flag' | 'env' | 'config.reviewAdapter' | 'config.adapter' | 'built-in default';
}

/**
 * Pick the review adapter.
 *
 * `isKnown` is injected rather than imported so an unknown name is reported
 * here instead of failing later inside the adapter registry with no context
 * about where the bad value came from.
 */
export function resolveReviewAdapter(
  sources: ReviewAdapterSources,
  isKnown: (name: string) => boolean,
  known: readonly string[] = [],
): ReviewAdapterChoice {
  const candidates: [ReviewAdapterChoice['source'], string | undefined][] = [
    ['flag', sources.flag],
    ['env', sources.env],
    ['config.reviewAdapter', sources.configReview],
    ['config.adapter', sources.configDefault],
  ];
  for (const [source, raw] of candidates) {
    const name = raw?.trim();
    if (!name) continue;
    // An unknown name must not silently fall through to a lower-precedence
    // source: the operator asked for something specific and would otherwise
    // get a different provider with no indication.
    if (!isKnown(name)) {
      // Name the value, where it came from, AND what would have worked. The
      // registry's own error lists the alternatives; an operator who hits this
      // one first should not have to go looking for that list.
      const options = known.length > 0 ? `. Available: ${known.join(', ')}` : '';
      throw new Error(`Unknown review adapter "${name}" (from ${source})${options}`);
    }
    return { name, source };
  }
  return { source: 'built-in default' };
}
