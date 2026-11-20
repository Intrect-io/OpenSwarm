// ============================================
// OpenSwarm - Launcher argument layout for the destructive shell-command guard
// Split out of shellCommandGuard.ts to keep that module small.
// Purpose: tell which word a launcher (`sudo`, `env`, `timeout`, ...) runs as
//          its program, so a run-time word there is refused (AGT-3436).
// ============================================

/**
 * How a launcher's own arguments are laid out, so the guard knows which word
 * is the program it runs. Everything before that slot is the launcher's: its
 * flags, the values those flags take, `NAME=value` assignments and fixed
 * operands (`timeout DURATION`). A flag missing from the table is read as
 * taking no value, which only moves the program slot earlier — fail closed.
 */
interface LauncherSpec {
  /** Short option letters that take a value (`-u root`, `-uroot`). */
  short?: string;
  /** Long options that take a value when not written `--opt=value`. */
  long?: readonly string[];
  /** Options whose value is itself a command line (`env -S`, `flock -c`). */
  commandValue?: readonly string[];
  /** Operands between the options and the program (`timeout DURATION`, `chroot NEWROOT`). */
  operands?: number;
  /** `NAME=value` words before the program are assignments, not the program. */
  assignments?: boolean;
}

/** Launchers with a fixed program slot. `su` (program only via `-c`) and `find` (after `-exec`) have none. */
const LAUNCHER_SPECS: Record<string, LauncherSpec> = {
  sudo: {
    short: 'ugChprtUDRT',
    long: ['--user', '--group', '--close-from', '--host', '--prompt', '--role', '--type', '--other-user', '--chdir', '--chroot', '--command-timeout'],
    assignments: true,
  },
  doas: { short: 'uC' },
  command: {},
  builtin: {},
  env: { short: 'uCS', long: ['--unset', '--chdir', '--split-string'], commandValue: ['-S', '--split-string'], assignments: true },
  nohup: {},
  setsid: {},
  time: { short: 'fo', long: ['--format', '--output'] },
  nice: { short: 'n', long: ['--adjustment'] },
  ionice: { short: 'cnpPu', long: ['--class', '--classdata', '--pid', '--pgid', '--uid'] },
  stdbuf: { short: 'ioe', long: ['--input', '--output', '--error'] },
  timeout: { short: 'sk', long: ['--signal', '--kill-after'], operands: 1 },
  watch: { short: 'nq', long: ['--interval', '--equexit'] },
  flock: { short: 'wEc', long: ['--timeout', '--wait', '--conflict-exit-code', '--command'], commandValue: ['-c', '--command'], operands: 1 },
  chroot: { long: ['--userspec', '--groups'], operands: 1 },
  exec: { short: 'a' },
  xargs: {
    short: 'adEILnPs',
    long: ['--arg-file', '--delimiter', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--process-slot-var'],
  },
  chrt: { short: 'TPD', long: ['--sched-runtime', '--sched-period', '--sched-deadline'], operands: 1 },
  taskset: { operands: 1 },
};

/** `find` actions whose next word is a program. */
const FIND_EXEC_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/**
 * Indices (into `args`, the words after the launcher) of the words that hold
 * a program or a command line: the launcher's program slot, the value of a
 * command-taking option, and for `find` the word after each `-exec`.
 */
export function launcherProgramWords(name: string, args: string[]): number[] {
  if (name === 'find') return args.flatMap((arg, i) => (FIND_EXEC_ACTIONS.has(arg) ? [i + 1] : []));
  const spec = LAUNCHER_SPECS[name];
  if (!spec) return [];
  const slots: number[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const word = args[i];
    if (word === '--') { i++; break; }
    if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const option = eq < 0 ? word : word.slice(0, eq);
      const takesNext = eq < 0 && (spec.long ?? []).includes(option);
      if (spec.commandValue?.includes(option)) slots.push(takesNext ? i + 1 : i);
      if (takesNext) i++;
      continue;
    }
    if (!word.startsWith('-') || word.length < 2) break;
    // A cluster (`-Eu root`, `-uroot`): the first value-taking letter takes
    // the rest of the word, or the next word when it ends the cluster.
    for (let j = 1; j < word.length; j++) {
      if (!(spec.short ?? '').includes(word[j])) continue;
      const attached = j < word.length - 1;
      if (spec.commandValue?.includes(`-${word[j]}`)) slots.push(attached ? i : i + 1);
      if (!attached) i++;
      break;
    }
  }
  slots.push(i + (spec.operands ?? 0));
  return slots.filter((slot) => slot < args.length);
}
