// ============================================
// OpenSwarm - Destructive shell-command guard
// Split out of tools.ts, which sits near the 1500-line pre-commit cap.
// Purpose: decide whether a bash tool command would run something destructive,
//          after the shell's own rewriting (quotes, escapes, braces) is applied.
// ============================================

import path from 'node:path';

/**
 * Destructive-command guard (AGT-3436).
 *
 * This was a regex sweep over the raw command text, and that shape was wrong in
 * both directions:
 *
 *  - It missed what bash does before running anything. Quote removal, backslash
 *    escapes, `$'...'` decoding and brace expansion all rewrite the command
 *    first, so `r"m" -rf /`, `\rm -rf /`, `$'\x72\x6d' -rf /`, `r{m,} -rf /`
 *    and `git clean -fdx` each execute a destructive command while containing
 *    no literal those patterns looked for.
 *  - It fired on text that is only data. `echo "rm -rf stays blocked"` and
 *    `# rm -rf /tmp/x` were refused, which is how a model learns to route
 *    around a guard rather than respect it.
 *
 * So the command is now resolved the way bash resolves it — quotes and escapes
 * removed, `$'...'` decoded, comments dropped, braces expanded — and matched by
 * WORD: the first word of a simple command is the program that runs, so a
 * destructive verb is one only where a program name sits. Anything that cannot
 * be resolved (an unclosed quote or substitution, a substitution spliced into a
 * word, a brace expansion past its cap) is refused rather than guessed at: a
 * false positive costs a retry, a false negative costs the working tree.
 */

/** How far the guard follows `$(...)`, backticks and `sh -c` scripts before refusing. */
const GUARD_MAX_DEPTH = 4;
/** Candidates `{a,b}` expansion may produce before the command is refused. */
const GUARD_MAX_EXPANSIONS = 32;
/** Words scanned for a launcher's real command (`sudo -u root rm -rf /`). */
const GUARD_MAX_WORDS = 64;

/** One simple command, split out of a `;`/`&&`/`||`/`|`/newline chain. */
interface ResolvedCommand {
  /** Words after quote removal, backslash escapes and brace expansion. */
  words: string[];
  /** Targets of `>`/`<` redirections, kept apart from arguments. */
  redirects: string[];
  /** Bodies of `$(...)`/backtick substitutions — each runs a command of its own. */
  nested: string[];
}

/** Programs that only launch another command: the real one is in the arguments. */
const COMMAND_LAUNCHERS: Record<string, true> = {
  sudo: true, doas: true, su: true, command: true, builtin: true, env: true,
  nohup: true, nice: true, ionice: true, stdbuf: true, setsid: true, time: true,
  timeout: true, watch: true, flock: true, chroot: true, exec: true, xargs: true,
  find: true,
};

/** Programs whose `-c` argument is a script the shell runs. */
const SCRIPT_HOSTS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true, ksh: true, su: true };

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/** Innermost `{a,b}` group bash would expand, or null when the word has none. */
function innermostBraceGroup(word: string): { start: number; end: number; alternatives: string[] } | null {
  let start = word.lastIndexOf('{');
  while (start >= 0) {
    const close = word.indexOf('}', start + 1);
    if (close >= 0) {
      const body = word.slice(start + 1, close);
      // Not innermost (the inner group expands first) and no alternative list
      // (`{x}` is literal to bash) both mean this brace is not a group.
      if (!body.includes('{') && body.includes(',')) {
        return { start, end: close + 1, alternatives: body.split(',') };
      }
    }
    // NB: `lastIndexOf('{', -1)` clamps to 0 and would rescan index 0 forever,
    // so the walk stops explicitly rather than relying on a negative fromIndex.
    if (start === 0) break;
    start = word.lastIndexOf('{', start - 1);
  }
  return null;
}

/**
 * Every word `{a,b}` expansion can produce, or null when the count explodes.
 * Each candidate is a word bash may run, so an unresolvable expansion is
 * refused instead of being matched as its own literal text.
 */
function expandBraces(word: string): string[] | null {
  let candidates = [word];
  for (;;) {
    const next: string[] = [];
    let expanded = false;
    for (const candidate of candidates) {
      const group = innermostBraceGroup(candidate);
      if (!group) {
        next.push(candidate);
        continue;
      }
      expanded = true;
      for (const alternative of group.alternatives) {
        next.push(candidate.slice(0, group.start) + alternative + candidate.slice(group.end));
      }
    }
    if (!expanded) return next;
    if (next.length > GUARD_MAX_EXPANSIONS) return null;
    candidates = next;
  }
}

/** Index of the `'` closing the `$'...'` quote that starts at `start`, or -1. */
function closingAnsiCQuote(command: string, start: number): number {
  for (let i = start + 1; i < command.length; i++) {
    if (command[i] === '\\') { i++; continue; }
    if (command[i] === "'") return i;
  }
  return -1;
}

/**
 * What `$'...'` resolves to: bash decodes backslash escapes there, so
 * `$'\x72\x6d' -rf /` runs `rm -rf /`. Decoding keeps the guard looking at the
 * characters the process will actually see.
 */
function decodeAnsiCQuote(body: string): string {
  return body.replace(
    /\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g,
    (_all, escape: string) => {
      const kind = escape[0];
      const code = kind === 'x' || kind === 'u' || kind === 'U'
        ? parseInt(escape.slice(1), 16)
        : kind >= '0' && kind <= '7' ? parseInt(escape, 8) : -1;
      if (code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      if (escape === 'n') return '\n';
      if (escape === 't') return '\t';
      if (escape === 'r') return '\r';
      return escape;
    },
  );
}

/** Index just past the `$(...)`, `${...}` or `` `...` `` span at `start`, or -1 when it never closes. */
function endOfSubstitution(command: string, start: number): number {
  if (command[start] === '`') {
    for (let i = start + 1; i < command.length; i++) {
      if (command[i] === '\\') { i++; continue; }
      if (command[i] === '`') return i + 1;
    }
    return -1;
  }
  const opens = command[start + 1];
  const closes = opens === '(' ? ')' : '}';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = start + 1; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === '\\' && quote === '"') { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '\\') { i++; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === opens) depth++;
    else if (char === closes && --depth === 0) return i + 1;
  }
  return -1;
}

interface SubstitutionSpan {
  /** The span as written, which is all the guard can know about its output. */
  text: string;
  /** The command inside `$(...)`/backticks, for recursive inspection. */
  body: string;
  /** Index just past the span. */
  end: number;
  runsCommand: boolean;
}

/**
 * The `$(...)`/`${...}`/`` `...` `` span at `i`: `'none'` when there is none,
 * `'unclosed'` when it never terminates (the caller refuses).
 */
function substitutionSpanAt(command: string, i: number): SubstitutionSpan | 'none' | 'unclosed' {
  const char = command[i];
  const dollar = char === '$' && (command[i + 1] === '(' || command[i + 1] === '{');
  if (char !== '`' && !dollar) return 'none';
  const end = endOfSubstitution(command, i);
  if (end < 0) return 'unclosed';
  const runsCommand = char === '`' || command[i + 1] === '(';
  const text = command.slice(i, end);
  return { text, body: runsCommand ? text.slice(char === '`' ? 1 : 2, -1) : text, end, runsCommand };
}

/**
 * The simple commands bash will run for `command`, each word resolved the way
 * bash resolves it. Returns null when the text cannot be resolved — see the
 * block comment above for why that is refused rather than matched.
 */
function resolveCommands(command: string): ResolvedCommand[] | null {
  const commands: ResolvedCommand[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let nested: string[] = [];
  let word = '';
  let wordStarted = false;
  let atWordStart = true;
  let redirectTarget = false;
  let unresolvable = false;
  let quote: '"' | "'" | null = null;

  const endWord = (): void => {
    if (!wordStarted) return;
    if (redirectTarget) redirects.push(word);
    else {
      const expanded = expandBraces(word);
      if (expanded === null) unresolvable = true;
      else words.push(...expanded);
    }
    word = '';
    wordStarted = false;
    redirectTarget = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length || redirects.length || nested.length) commands.push({ words, redirects, nested });
    words = [];
    redirects = [];
    nested = [];
    atWordStart = true;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }

    if (quote === '"') {
      if (char === '"') { quote = null; continue; }
      if (char === '\\') {
        const next = command[i + 1];
        if (next === undefined) return null;
        if (next === '"' || next === '\\' || next === '$' || next === '`') { word += next; i++; }
        else if (next === '\n') i++;
        else word += char;
        continue;
      }
      const span = substitutionSpanAt(command, i);
      if (span === 'unclosed') return null;
      if (span !== 'none') {
        // `r"$(true)"m` is `rm` once the quotes come off: a splice is refused
        // because the guard cannot know what the substitution yields.
        if (isWordChar(word[word.length - 1]) || isWordChar(command[span.end])) return null;
        word += span.text;
        if (span.runsCommand) nested.push(span.body);
        i = span.end - 1;
        continue;
      }
      word += char;
      continue;
    }

    const ifs = /^\$\{IFS\}|\$IFS(?![A-Za-z0-9_])/.exec(command.slice(i, i + 6));
    if (ifs) {
      // `rm$IFS-rf` is `rm -rf`: bash splits the word where IFS expands.
      endWord();
      atWordStart = true;
      i += ifs[0].length - 1;
      continue;
    }
    if (char === '\\') {
      const next = command[i + 1];
      if (next === undefined) return null;
      if (next !== '\n') { word += next; wordStarted = true; atWordStart = false; }
      i++;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; wordStarted = true; atWordStart = false; continue; }
    if (char === '$' && command[i + 1] === "'") {
      const close = closingAnsiCQuote(command, i + 1);
      if (close < 0) return null;
      word += decodeAnsiCQuote(command.slice(i + 2, close));
      wordStarted = true;
      atWordStart = false;
      i = close;
      continue;
    }
    if (char === ' ' || char === '\t') { endWord(); atWordStart = true; continue; }
    if (char === '\n' || char === ';' || char === '&' || char === '|') {
      endCommand();
      if (char !== '\n' && command[i + 1] === char) i++;
      continue;
    }
    if (char === '>' || char === '<') {
      endWord();
      atWordStart = true;
      redirectTarget = false;
      if (command[i + 1] === char) { i++; redirectTarget = char === '>'; }   // `>> device`
      else if (command[i + 1] === '&') i++;                                  // `>&2` duplicates a descriptor
      else redirectTarget = char === '>';
      continue;
    }
    if (char === '#' && atWordStart) {
      const newline = command.indexOf('\n', i);
      endCommand();
      if (newline < 0) break;
      i = newline;
      continue;
    }
    const span = substitutionSpanAt(command, i);
    if (span === 'unclosed') return null;
    if (span !== 'none') {
      if (isWordChar(word[word.length - 1]) || isWordChar(command[span.end])) return null;
      word += span.text;
      wordStarted = true;
      atWordStart = false;
      if (span.runsCommand) nested.push(span.body);
      i = span.end - 1;
      continue;
    }
    word += char;
    wordStarted = true;
    atWordStart = false;
  }

  if (unresolvable) return null;
  if (quote !== null) return null;   // an unclosed quote swallows the rest of the line
  endCommand();
  return commands;
}

/**
 * The destructive shapes, as predicates over (program, arguments). Kept apart
 * from the resolution above so the two questions stay separable: what will run,
 * and is that thing destructive.
 */
const DESTRUCTIVE_RULES: ReadonlyArray<(name: string, args: string[]) => boolean> = [
  // `rm -rf`, `rm -fr`, `rm -R`, `rm --recursive` — the recursive flag is the destructive part.
  (name, args) => name === 'rm' && args.some((arg) => arg === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg)),
  (name, args) => name === 'git' && args.includes('reset') && args.includes('--hard'),
  // `git clean` deletes untracked files once force meets directories: `-fd`, `-fdx`, `-d -f`.
  (name, args) => name === 'git' && args.includes('clean')
    && args.some((arg) => arg === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg))
    && args.some((arg) => /^-[A-Za-z]*d[A-Za-z]*$/.test(arg)),
  (name, args) => name === 'chmod' && args.some((arg) => /^[0-7]*777[0-7]*$/.test(arg)),
  (name, args) => name === 'chown'
    && args.some((arg) => arg === '--recursive' || /^-[A-Za-z]*R[A-Za-z]*$/.test(arg)),
  (name, args) => name === 'dd' && args.some((arg) => arg.startsWith('if=')),
  (name, args) => (name === 'kill' || name === 'pkill')
    && args.some((arg) => /^-[A-Za-z]*9$/.test(arg) || /^-(SIG)?KILL$/i.test(arg)),
];

/** Is one resolved simple command destructive? */
function resolvedCommandIsBlocked(command: ResolvedCommand, depth: number): boolean {
  if (command.redirects.some((target) => target.startsWith('/dev/sd'))) return true;
  // SQL verbs are destructive wherever they sit in the line: a client reads
  // them as a statement, so position cannot separate `psql -c "drop database
  // app"` from a word that merely mentions one.
  const joined = command.words.join(' ');
  if (/\bdrop\s+database\b/i.test(joined) || /\btruncate\s+table\b/i.test(joined)) return true;

  if (depth < GUARD_MAX_DEPTH) {
    for (const script of command.nested) {
      if (isCommandBlocked(script, depth + 1)) return true;
    }
  }

  let start = 0;
  while (command.words[start] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.words[start])) start++;  // `FOO=bar rm -rf /`
  const name = path.basename(command.words[start] ?? '');
  const args = command.words.slice(start + 1);

  if (depth < GUARD_MAX_DEPTH) {
    // `sh -c '<script>'`, `su -xc '<script>'`: the script is a command line of its own.
    const scriptFlag = SCRIPT_HOSTS[name] ? args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) : -1;
    if (scriptFlag >= 0 && isCommandBlocked(args.slice(scriptFlag + 1).join(' '), depth + 1)) return true;
    if (name === 'eval' && isCommandBlocked(args.join(' '), depth + 1)) return true;
    if (COMMAND_LAUNCHERS[name]) {
      // The launcher's own arguments may still be flags with values
      // (`sudo -u root rm -rf /`), so every suffix is a candidate command.
      const limit = Math.min(command.words.length, start + GUARD_MAX_WORDS);
      for (let i = start + 1; i < limit; i++) {
        const suffix = { words: command.words.slice(i), redirects: command.redirects, nested: command.nested };
        if (resolvedCommandIsBlocked(suffix, depth + 1)) return true;
      }
    }
  }

  return DESTRUCTIVE_RULES.some((rule) => rule(name, args));
}

/**
 * Would running this command line destroy something, once the shell has
 * rewritten it? Unresolvable input is blocked, not waved through.
 */
export function isCommandBlocked(command: string, depth = 0): boolean {
  const commands = resolveCommands(command);
  if (commands === null) return true;
  return commands.some((resolved) => resolvedCommandIsBlocked(resolved, depth));
}
