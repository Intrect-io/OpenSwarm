// ============================================
// OpenSwarm - Interactive prompt helper
// ============================================
//
// Minimal ask/choose/confirm on node:readline/promises for the first-run wizard
// (INT-1578). The resolve* functions are pure so the parsing is unit-testable
// without a live TTY.

import { createInterface } from 'node:readline';
import { stdin as processStdin, stdout as processStdout } from 'node:process';
import type { Readable, Writable } from 'node:stream';

export interface ChoiceOption<T> {
  label: string;
  value: T;
  hint?: string;
}

/**
 * Resolve a raw answer against numbered options. Accepts a 1-based index or an
 * exact label (case-insensitive). Returns null when nothing matches.
 */
export function resolveChoice<T>(raw: string, options: ChoiceOption<T>[]): ChoiceOption<T> | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
  const lower = t.toLowerCase();
  return options.find((o) => o.label.toLowerCase() === lower) ?? null;
}

/** Resolve a yes/no answer; an empty answer returns the default. */
export function resolveConfirm(raw: string, def: boolean): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return def;
  if (t === 'y' || t === 'yes' || t === 'true') return true;
  if (t === 'n' || t === 'no' || t === 'false') return false;
  return def;
}

export interface Prompter {
  /** Free-text question; returns the trimmed answer or `def` if blank. */
  ask(question: string, def?: string): Promise<string>;
  /** Numbered menu; re-prompts until a valid option is chosen. */
  choose<T>(question: string, options: ChoiceOption<T>[]): Promise<T>;
  /** Yes/no; blank answer takes `def`. */
  confirm(question: string, def?: boolean): Promise<boolean>;
  close(): void;
}

/**
 * Most stdin lines held before a question asks for them.
 *
 * Every question takes one line, so a scripted answer file is far shorter than
 * this. More than this many unasked lines is a runaway pipe, not answers.
 */
export const MAX_LINE_QUEUE = 100;

export function createPrompter(input: Readable = processStdin, output: Writable = processStdout): Prompter {
  // Drain readline's `line` events into a queue and hand them out one at a time.
  // rl.question (both callback and promises forms) drops lines when a pipe
  // delivers several at once and then EOFs; queueing the line events is robust
  // for both piped stdin and a live TTY.
  const rl = createInterface({ input, output });
  const lineQueue: string[] = [];
  const waiters: Array<{ resolve: (l: string) => void; reject: (e: Error) => void }> = [];
  let closed = false;
  // Set when the queue overflows. Dropping lines to stay under the bound would
  // shift every later answer onto the wrong question, so the prompter fails
  // instead: queued lines are discarded and every further question rejects.
  let overflowed = false;
  const overflowError = () =>
    new Error(`stdin sent more than ${MAX_LINE_QUEUE} lines before they were asked for; refusing to guess which answer goes where`);

  rl.on('line', (line: string) => {
    if (overflowed) return;
    const w = waiters.shift();
    if (w) w.resolve(line);
    else if (lineQueue.length >= MAX_LINE_QUEUE) {
      overflowed = true;
      lineQueue.length = 0;
      rl.close();
    } else lineQueue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    const err = () => (overflowed ? overflowError() : new Error('input stream closed before all answers were given'));
    while (waiters.length) waiters.shift()!.reject(err());
  });

  const nextLine = (): Promise<string> => {
    if (overflowed) return Promise.reject(overflowError());
    if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
    if (closed) return Promise.reject(new Error('input stream closed before all answers were given'));
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const question = (prompt: string): Promise<string> => {
    output.write(prompt);
    return nextLine();
  };

  return {
    async ask(q: string, def?: string): Promise<string> {
      const suffix = def ? ` [${def}]` : '';
      const ans = (await question(`${q}${suffix}: `)).trim();
      return ans || def || '';
    },
    async choose<T>(q: string, options: ChoiceOption<T>[]): Promise<T> {
      output.write(`${q}\n`);
      options.forEach((o, i) => output.write(`  ${i + 1}) ${o.label}${o.hint ? ` — ${o.hint}` : ''}\n`));
      for (;;) {
        const raw = await question('> ');
        const picked = resolveChoice(raw, options);
        if (picked) return picked.value;
        output.write('Please enter a valid number or label.\n');
      }
    },
    async confirm(q: string, def = true): Promise<boolean> {
      const hint = def ? '[Y/n]' : '[y/N]';
      const raw = await question(`${q} ${hint}: `);
      return resolveConfirm(raw, def);
    },
    close(): void {
      rl.close();
    },
  };
}
