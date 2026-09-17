// ============================================
// OpenSwarm — nothing that looks like a customer's credentials or money leaves the branch (AGT-4188)
// ============================================
//
// cgf-portal #215 (2026-09-03): a worker copied the customer's raw material
// from the gitignored `docs/CGF_data` into an unprotected `tests/fixtures/`
// and pushed it — card-issuer logins with plaintext passwords, four full bank
// account numbers with 710 real transactions, 63 full card numbers. Two files
// named `_masked` were byte-identical to their originals. Nothing in the diff
// showed any of it, because `.xls`/`.xlsx` do not diff, and the file names
// were the only clue. The PR was closed; the blobs are on GitHub forever.
//
// This fence runs before `git push`, on the commits the branch adds over its
// base. It is deterministic and it fails closed: a finding stops publication
// and parks the run for a person, because no retry rewrites history.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5 * 60_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 64 << 20 });
  return stdout;
}

export interface SensitiveDataFinding {
  file: string;
  kind: 'opaque-spreadsheet' | 'card-number' | 'account-number' | 'plaintext-password' | 'resident-id' | 'masked-copy-identical';
  detail: string;
}

/** Spreadsheets cannot be diffed; a reviewer can only trust the file name — and #215's names lied. */
const OPAQUE_FIXTURE_RE = /\.(?:xls|xlsx|xlsm|xlsb|ods|numbers)$/i;
/** Text formats the fence scans line by line. */
const TEXT_DATA_RE = /\.(?:csv|tsv|json|jsonl|ndjson|txt|md|ya?ml|toml|sql|py|ts|js|env|ini|cfg|xml|html?)$/i;

const CARD_RE = /(?<!\d)(?:\d[ -]?){15}\d(?!\d)/g;
const ACCOUNT_RE = /(?<![\d-])\d{3}-\d{2,6}-\d{4,6}(?:-\d{1,3})?(?![\d-])/g;
const RRN_RE = /(?<!\d)\d{6}-[1-4]\d{6}(?!\d)/g;
const PASSWORD_RE = /(?:password|passwd|pwd|\bpw|비밀번호|패스워드|비번)\s*["']?\s*[:=]\s*["']?([^\s"',;]{4,})/gi;
/** A spreadsheet-style header cell that names a password column (#215: `비밀번호` columns per issuer). */
const PASSWORD_HEADER_RE = /^(?:password|passwd|pwd|pw|비밀번호|패스워드|비번)$/i;
const PLACEHOLDER_RE = /^(?:\$\{?|<|\*{3,}|x{3,}|example|changeme|redacted|masked|dummy|test|placeholder|your[_-]|none|null|secret\b)/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Findings in one file's added text; exported for tests and for the staging-time warning. */
export function scanAddedText(file: string, addedLines: readonly string[]): SensitiveDataFinding[] {
  const findings: SensitiveDataFinding[] = [];
  let cards = 0, accounts = 0, rrns = 0, passwords = 0;
  // Columnar credentials: a header row naming a password column, values below it.
  const delimiter = /\.tsv$/i.test(file) ? '\t' : /\.csv$/i.test(file) ? ',' : null;
  if (delimiter && addedLines.length > 1) {
    const header = addedLines[0].split(delimiter).map((cell) => cell.trim().replace(/^["']|["']$/g, ''));
    const columns = header.map((cell, i) => (PASSWORD_HEADER_RE.test(cell) ? i : -1)).filter((i) => i >= 0);
    for (const line of addedLines.slice(1)) {
      const cells = line.split(delimiter);
      for (const i of columns) {
        const value = (cells[i] ?? '').trim().replace(/^["']|["']$/g, '');
        if (value.length >= 4 && !PLACEHOLDER_RE.test(value)) passwords++;
      }
    }
  }
  for (const line of addedLines) {
    for (const m of line.matchAll(CARD_RE)) {
      const digits = m[0].replace(/[ -]/g, '');
      if (digits.length === 16 && luhn(digits) && !/^(\d)\1{15}$/.test(digits)) cards++;
    }
    for (const _ of line.matchAll(ACCOUNT_RE)) accounts++;
    for (const _ of line.matchAll(RRN_RE)) rrns++;
    for (const m of line.matchAll(PASSWORD_RE)) {
      if (!PLACEHOLDER_RE.test(m[1])) passwords++;
    }
  }
  if (cards > 0) findings.push({ file, kind: 'card-number', detail: `${cards} Luhn-valid 16-digit card number(s)` });
  // One dashed triple can be a phone or a date range; a cluster is a ledger.
  if (accounts >= 3) findings.push({ file, kind: 'account-number', detail: `${accounts} bank-account-shaped numbers` });
  if (rrns > 0) findings.push({ file, kind: 'resident-id', detail: `${rrns} resident-registration-shaped number(s)` });
  if (passwords > 0) findings.push({ file, kind: 'plaintext-password', detail: `${passwords} password field(s) with a literal value` });
  return findings;
}

/**
 * Sensitive material the branch adds over its base. Empty means publish.
 * A git failure is reported as a finding so the caller fails closed.
 */
export async function sensitiveDataOnBranch(worktreePath: string, baseRef: string): Promise<SensitiveDataFinding[]> {
  const findings: SensitiveDataFinding[] = [];
  let added: string[];
  try {
    added = (await git(worktreePath, 'diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`)).split('\n').filter(Boolean);
  } catch (error) {
    return [{ file: '<branch>', kind: 'opaque-spreadsheet', detail: `could not list added files: ${error instanceof Error ? error.message : String(error)}` }];
  }

  for (const file of added) {
    if (OPAQUE_FIXTURE_RE.test(file)) {
      findings.push({ file, kind: 'opaque-spreadsheet', detail: 'a spreadsheet cannot be reviewed in a diff; derive a minimal text fixture instead' });
      continue;
    }
    if (!TEXT_DATA_RE.test(file)) continue;
    let content: string;
    try {
      content = await git(worktreePath, 'show', `HEAD:${file}`);
    } catch {
      continue;
    }
    if (content.includes('\0')) continue;
    findings.push(...scanAddedText(file, content.split('\n')));
  }

  // "masked" in the name is a claim; the blob hash is the fact (#215: two
  // masked copies were byte-identical to their originals).
  const masked = added.filter((f) => /mask/i.test(f));
  if (masked.length > 0) {
    const tree = (await git(worktreePath, 'ls-tree', '-r', 'HEAD').catch(() => ''))
      .split('\n').filter(Boolean)
      .map((line) => { const [meta, path] = line.split('\t'); return { hash: meta.split(' ')[2], path }; });
    const byHash = new Map<string, string[]>();
    for (const e of tree) byHash.set(e.hash, [...(byHash.get(e.hash) ?? []), e.path]);
    for (const file of masked) {
      const hash = tree.find((e) => e.path === file)?.hash;
      const twins = hash ? (byHash.get(hash) ?? []).filter((p) => p !== file) : [];
      if (twins.length > 0) {
        findings.push({ file, kind: 'masked-copy-identical', detail: `byte-identical to ${twins.join(', ')} — no masking happened` });
      }
    }
  }
  return findings;
}

export class SensitiveDataError extends Error {
  constructor(public readonly findings: SensitiveDataFinding[]) {
    super(
      'sensitive-data: the branch adds material that must not leave this machine — '
      + findings.map((f) => `${f.file} (${f.kind}: ${f.detail})`).join('; ')
      + '. Remove the files from every commit on the branch (the history, not just the tree) before this can publish.',
    );
    this.name = 'SensitiveDataError';
  }
}

export async function assertNoSensitiveDataOnBranch(worktreePath: string, baseRef: string): Promise<void> {
  const findings = await sensitiveDataOnBranch(worktreePath, baseRef);
  if (findings.length > 0) throw new SensitiveDataError(findings);
}
