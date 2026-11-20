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
  /** Per word (parallel to `words`): what of it the shell fills in at run time. */
  dynamics: WordDynamics[];
}

/**
 * What part of a word only exists at run time. `$X`, `${X}`, `$(...)` and
 * backticks produce text the guard cannot see, so a word that carries one is
 * an unknown: in program position it can be any program (`X=rm; $X -rf /`),
 * and where it can start with `-` it can be any flag (`rm $(echo -rf) /x`).
 */
interface WordDynamics {
  /** The word contains at least one unresolved expansion. */
  any: boolean;
  /** An expansion comes before any literal character, so it decides how the word starts. */
  leading: boolean;
  /** An expansion sits outside double quotes, so word splitting can turn it into several words. */
  unquoted: boolean;
}

const STATIC_WORD: WordDynamics = { any: false, leading: false, unquoted: false };

/** Programs that only launch another command: the real one is in the arguments. */
const COMMAND_LAUNCHERS: Record<string, true> = {
  sudo: true, doas: true, su: true, command: true, builtin: true, env: true,
  nohup: true, nice: true, ionice: true, stdbuf: true, setsid: true, time: true,
  timeout: true, watch: true, flock: true, chroot: true, exec: true, xargs: true,
  find: true,
};

/**
 * Reserved words that precede a command inside a compound statement:
 * `for f in a; do rm -rf /x; done` runs `rm` from the word after `do`, and
 * `{ rm -rf /x; }` from the word after `{`.
 */
const COMPOUND_PREFIXES: ReadonlySet<string> = new Set(['do', 'then', 'else', 'if', 'elif', 'while', 'until', '!', '{', 'coproc']);

/** Characters after `$` that make it a parameter expansion bash fills in (`$X`, `$1`, `$@`, `$$`). */
const PARAMETER_START = /[A-Za-z_0-9@*#?!$-]/;

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
  const processSubstitution = (char === '<' || char === '>') && command[i + 1] === '(';
  const dollar = char === '$' && (command[i + 1] === '(' || command[i + 1] === '{');
  if (char !== '`' && !dollar && !processSubstitution) return 'none';
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
  let dynamics: WordDynamics[] = [];
  let word = '';
  let wordDynamics: WordDynamics = { ...STATIC_WORD };
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
      else {
        words.push(...expanded);
        for (let n = 0; n < expanded.length; n++) dynamics.push(wordDynamics);
      }
    }
    word = '';
    wordDynamics = { ...STATIC_WORD };
    wordStarted = false;
    redirectTarget = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length || redirects.length || nested.length) commands.push({ words, redirects, nested, dynamics });
    words = [];
    redirects = [];
    nested = [];
    dynamics = [];
    atWordStart = true;
  };
  /** Record that the shell fills in part of the current word at run time. */
  const markDynamic = (quoted: boolean): void => {
    wordDynamics = {
      any: true,
      leading: wordDynamics.leading || (word === '' && !wordDynamics.any),
      unquoted: wordDynamics.unquoted || !quoted,
    };
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
      // Inside double quotes bash expands only `$` and backticks; `<(`/`>(`
      // there is literal text (`"Map<(K,V)>"`), not process substitution.
      const span = char === '<' || char === '>' ? 'none' : substitutionSpanAt(command, i);
      if (span === 'unclosed') return null;
      if (span !== 'none') {
        // `r"$(true)"m` is `rm` once the quotes come off: a splice is refused
        // because the guard cannot know what the substitution yields.
        if (isWordChar(word[word.length - 1]) || isWordChar(command[span.end])) return null;
        markDynamic(true);
        word += span.text;
        if (span.runsCommand) nested.push(span.body);
        i = span.end - 1;
        continue;
      }
      if (char === '$' && PARAMETER_START.test(command[i + 1] ?? '')) markDynamic(true);
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
    // `$"rm"` is a locale-translated string: bash drops the `$` and reads
    // `"rm"`, so `$"rm" -rf /x` runs `rm`. The `"` is handled next iteration.
    if (char === '$' && command[i + 1] === '"') continue;
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
    // `(` and `)` open and close a subshell: `(rm -rf /x)` runs `rm`.
    if (char === '\n' || char === ';' || char === '&' || char === '|' || char === '(' || char === ')') {
      endCommand();
      if (char !== '\n' && command[i + 1] === char) i++;
      continue;
    }
    if (char === '>' || char === '<') {
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
      markDynamic(false);
      word += span.text;
      wordStarted = true;
      atWordStart = false;
      if (span.runsCommand) nested.push(span.body);
      i = span.end - 1;
      continue;
    }
    if (char === '$' && PARAMETER_START.test(command[i + 1] ?? '')) markDynamic(false);
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
/** git's global options that take the next word as their value (`git -C dir reset`). */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

/**
 * git's subcommand and the words after it, or null when there is none. The
 * subcommand is the first word after the global options; matching `reset`
 * anywhere in the line would make `git push origin reset` look like one.
 */
function gitSubcommand(args: string[]): { sub: string; rest: string[] } | null {
  for (let i = 0; i < args.length; i++) {
    if (GIT_VALUE_OPTIONS.has(args[i])) { i++; continue; }
    if (args[i].startsWith('-')) continue;
    return { sub: args[i], rest: args.slice(i + 1) };
  }
  return null;
}

const DESTRUCTIVE_RULES: ReadonlyArray<(name: string, args: string[]) => boolean> = [
  // `rm -rf`, `rm -fr`, `rm -R`, `rm --recursive` — the recursive flag is the destructive part.
  (name, args) => name === 'rm' && args.some((arg) => arg === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg)),
  (name, args) => {
    const git = name === 'git' ? gitSubcommand(args) : null;
    return git?.sub === 'reset' && git.rest.includes('--hard');
  },
  // `git clean` deletes untracked files once force meets directories: `-fd`, `-fdx`, `-d -f`.
  (name, args) => {
    const git = name === 'git' ? gitSubcommand(args) : null;
    return git?.sub === 'clean'
      && git.rest.some((arg) => arg === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg))
      && git.rest.some((arg) => /^-[A-Za-z]*d[A-Za-z]*$/.test(arg));
  },
  // The mode is chmod's first non-flag argument; a FILE named `777` is not a mode.
  (name, args) => name === 'chmod' && /^[0-7]*777[0-7]*$/.test(args.find((arg) => !arg.startsWith('-')) ?? ''),
  (name, args) => name === 'chown'
    && args.some((arg) => arg === '--recursive' || /^-[A-Za-z]*R[A-Za-z]*$/.test(arg)),
  (name, args) => name === 'dd' && args.some((arg) => arg.startsWith('if=')),
  (name, args) => (name === 'kill' || name === 'pkill')
    && args.some((arg) => /^-[A-Za-z]*9$/.test(arg) || /^-(SIG)?KILL$/i.test(arg)),
];

/** A launcher's own option, assignment or count (`-n`, `FOO=1`, `30`, `5m`) — not a program. */
function isLauncherOption(word: string): boolean {
  return word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /^\d+(?:\.\d+)?[smhd]?$/.test(word);
}

/** Programs a rule above can match — the only ones whose unknown flags matter. */
const DESTRUCTIVE_PROGRAMS: readonly string[] = ['rm', 'git', 'chmod', 'chown', 'dd', 'kill', 'pkill'];

/**
 * Values an unknown word may stand for when it can start a flag. Each one
 * completes some rule above, so trying them answers "can the shell's value for
 * this word make the command destructive?".
 */
const FLAG_STAND_INS: readonly string[] = ['-r', '--hard', '-fd', '-R', '777', 'if=/dev/zero', '-9', 'reset', 'clean'];

function rulesMatch(name: string, args: string[]): boolean {
  return DESTRUCTIVE_RULES.some((rule) => rule(name, args));
}

/** Is there an argument that is not a flag — something the command acts on? */
function hasOperand(args: string[]): boolean {
  return args.some((arg) => arg !== '--' && !arg.startsWith('-'));
}

/**
 * Word lists an unknown argument may turn into. A double-quoted expansion
 * stays one word, so it can only become one stand-in. An unquoted one is split
 * on whitespace, so it can also become a flag followed by a target, or two
 * flags and a target (`F="-rf /x"; rm $F`), after any literal text it began with.
 */
function standInExpansions(word: string, dynamics: WordDynamics): string[][] {
  const single = FLAG_STAND_INS.map((standIn) => [standIn]);
  if (!dynamics.unquoted) return single;
  const split: string[][] = [...single];
  for (const first of FLAG_STAND_INS) {
    split.push([first, '/x']);
    for (const second of FLAG_STAND_INS) split.push([first, second, '/x']);
  }
  return dynamics.leading ? split : [...split, ...split.map((words) => [word, ...words])];
}

/**
 * Could the run-time value of an unknown argument make `name args` destructive?
 *
 * A double-quoted unknown is a flag candidate only when it decides how the
 * word starts (`"$(echo -rf)"`) or the word already starts with `-` (`-"$F"`),
 * and it must still leave an operand to act on: `rm -f "$tmp"` stays allowed,
 * since at worst it is `rm -f -r` with nothing to remove. An unquoted unknown
 * is split by the shell wherever it sits, so `rm -f $tmp` and `rm ./$NAME.js`
 * are refused — quote the variable and they pass. Words after `--` are
 * operands whatever they expand to.
 */
function unknownFlagIsDestructive(name: string, args: string[], argDynamics: WordDynamics[]): boolean {
  if (!DESTRUCTIVE_PROGRAMS.includes(name)) return false;
  const endOfFlags = args.indexOf('--');
  for (let i = 0; i < args.length; i++) {
    if (endOfFlags >= 0 && i > endOfFlags) break;
    const dynamics = argDynamics[i] ?? STATIC_WORD;
    if (!dynamics.any) continue;
    if (!dynamics.unquoted && !(dynamics.leading || args[i].startsWith('-'))) continue;
    for (const expansion of standInExpansions(args[i], dynamics)) {
      const candidate = [...args.slice(0, i), ...expansion, ...args.slice(i + 1)];
      if (rulesMatch(name, candidate) && hasOperand(candidate)) return true;
    }
  }
  return false;
}

/**
 * Could an unknown program, run with these arguments, be a destructive one?
 * An unquoted program word is split at run time, so it may also carry flags of
 * its own: `X="rm -rf"; sudo $X /x` runs `rm -rf /x`. A bare-word target
 * (`sudo $X build`) is not covered: it reads the same as a program name.
 */
function unknownProgramIsDestructive(args: string[], argDynamics: WordDynamics[], programUnquoted = false): boolean {
  return DESTRUCTIVE_PROGRAMS.some((name) => {
    if (rulesMatch(name, args) || unknownFlagIsDestructive(name, args, argDynamics)) return true;
    // Only when the next word is a target, not another program: in
    // `timeout $T npm test` / `nice -n $N npm test` the dynamic word is the
    // launcher's own value and `npm` is the program, judged on its own.
    if (!programUnquoted || args.length === 0 || /^[A-Za-z_][\w.+-]*$/.test(args[0])) return false;
    return FLAG_STAND_INS.some((first) => {
      const one = [first, ...args];
      if (rulesMatch(name, one) && hasOperand(one)) return true;
      return FLAG_STAND_INS.some((second) => {
        const two = [first, second, ...args];
        return rulesMatch(name, two) && hasOperand(two);
      });
    });
  });
}

/**
 * The destructive programs an unquoted glob in program position may expand to:
 * `/bin/r[m] -rf /x` and `/bin/r? -rf /x` run `rm`. `[`/`[[` are the test
 * builtins, not patterns.
 */
function globbedPrograms(word: string): string[] {
  const base = path.basename(word);
  if (base === '[' || base === '[[' || !/[*?[]/.test(base)) return [];
  let pattern = '';
  for (let i = 0; i < base.length; i++) {
    const c = base[i];
    if (c === '*') pattern += '.*';
    else if (c === '?') pattern += '.';
    else if (c === '[') {
      const close = base.indexOf(']', i + 2);
      if (close < 0) { pattern += '\\['; continue; }
      const body = base.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
      pattern += `[${body}]`;
      i = close;
    } else pattern += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  let re: RegExp;
  try { re = new RegExp(`^${pattern}$`); } catch { return [...DESTRUCTIVE_PROGRAMS]; }
  return DESTRUCTIVE_PROGRAMS.filter((name) => re.test(name));
}

/**
 * Is one resolved simple command destructive?
 *
 * `asLauncherSuffix` marks a candidate the launcher scan built by dropping the
 * launcher's leading words. There the first word is only POSSIBLY the program
 * (`timeout $T npm test` — `$T` is a duration), so an unknown first word is
 * judged by what follows it instead of being refused outright.
 */
function resolvedCommandIsBlocked(command: ResolvedCommand, depth: number, asLauncherSuffix = false, programSlot = false): boolean {
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
  const argDynamics = command.dynamics.slice(start + 1);

  if (command.dynamics[start]?.any) {
    // The program is whatever `$X`/`$(...)` yields at run time:
    // `X=rm; $X -rf /`, `$(echo rm) -rf /`. The guard cannot know it, so it
    // refuses rather than guess — except in a launcher suffix, where the word
    // may be the launcher's own argument and the rest of the line decides.
    // With nothing after it, and only the launcher's options before it, it can
    // only be the program the launcher runs: `command $X`, `timeout 5 $X`,
    // `env $(echo rm -rf /x)`. (`timeout 30 cat $F` has `cat` before it.)
    if (!asLauncherSuffix || (programSlot && args.length === 0)) return true;
    if (unknownProgramIsDestructive(args, argDynamics, command.dynamics[start].unquoted)) return true;
  }

  for (const globbed of globbedPrograms(command.words[start] ?? '')) {
    if (rulesMatch(globbed, args) || unknownFlagIsDestructive(globbed, args, argDynamics)) return true;
  }

  if (depth < GUARD_MAX_DEPTH) {
    // `sh -c '<script>'`, `su -xc '<script>'`: the script is a command line of its own.
    const scriptFlag = SCRIPT_HOSTS[name] ? args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) : -1;
    if (scriptFlag >= 0 && isCommandBlocked(args.slice(scriptFlag + 1).join(' '), depth + 1)) return true;
    if (name === 'eval' && isCommandBlocked(args.join(' '), depth + 1)) return true;
    // After `do`/`then`/`{`/`!` the next word IS the program, so it gets the
    // strict program-position rule (`{ $X; }`), not the launcher's leniency.
    if (COMPOUND_PREFIXES.has(name) && command.words.length > start + 1) {
      const next: ResolvedCommand = {
        words: command.words.slice(start + 1),
        redirects: command.redirects,
        nested: command.nested,
        dynamics: command.dynamics.slice(start + 1),
      };
      if (resolvedCommandIsBlocked(next, depth + 1)) return true;
    }
    if (COMMAND_LAUNCHERS[name]) {
      // The launcher's own arguments may still be flags with values
      // (`sudo -u root rm -rf /`), so every suffix is a candidate command.
      const limit = Math.min(command.words.length, start + GUARD_MAX_WORDS);
      for (let i = start + 1; i < limit; i++) {
        const suffix: ResolvedCommand = {
          words: command.words.slice(i),
          redirects: command.redirects,
          nested: command.nested,
          dynamics: command.dynamics.slice(i),
        };
        const programSlot = command.words.slice(start + 1, i).every(isLauncherOption);
        if (resolvedCommandIsBlocked(suffix, depth + 1, true, programSlot)) return true;
      }
    }
  }

  return rulesMatch(name, args) || unknownFlagIsDestructive(name, args, argDynamics);
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
