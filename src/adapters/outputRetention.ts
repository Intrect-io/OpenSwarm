// ============================================
// OpenSwarm - Bounded CLI output retention (AGT-3423)
// A CLI stage's stdout/stderr used to be concatenated without limit for the
// whole run. Keep the most recent output instead: stream-json results, costs
// and error events are at the end, and parsers read line by line, so the
// retained text starts on a line boundary and is prefixed with a plain-text
// marker that JSON-line parsers skip.
// ============================================

/** Retained stdout per CLI stage. Far above a normal run; a runaway stream is the case it guards. */
export const MAX_RETAINED_STDOUT_CHARS = 32 * 1024 * 1024;
/** Retained stderr per CLI stage. */
export const MAX_RETAINED_STDERR_CHARS = 1024 * 1024;

export class BoundedOutput {
  private text = '';
  private dropped = 0;

  constructor(private readonly maxChars: number) {
    if (!Number.isFinite(maxChars) || maxChars < 1) throw new Error(`invalid output cap: ${maxChars}`);
  }

  append(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.maxChars) this.trim();
  }

  /** Characters dropped from the front so far. */
  get droppedChars(): number {
    return this.dropped;
  }

  toString(): string {
    return this.dropped > 0
      ? `[openswarm: ${this.dropped} earlier characters of output were not retained]\n${this.text}`
      : this.text;
  }

  // Trim to three quarters of the cap so a steady stream trims once per
  // quarter-cap of input rather than on every chunk.
  private trim(): void {
    const keep = Math.max(1, Math.floor(this.maxChars * 0.75));
    let cut = this.text.length - keep;
    // Start on a whole line when one begins reasonably soon after the cut.
    const newline = this.text.indexOf('\n', cut);
    if (newline !== -1 && newline - cut < keep / 2) cut = newline + 1;
    this.dropped += cut;
    this.text = this.text.slice(cut);
  }
}
