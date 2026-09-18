// ============================================
// OpenSwarm — a gate that only reports is not a gate (AGT-3107)
// ============================================
//
// de-artifact 2026-07-28: a commit titled "gate on PresentPreset — regression
// class" added code that read the property, checked the call returned noErr,
// and wrote the returned value into the QC JSON. Nothing compared that value
// to anything. The shell gate list stayed as it was. A fork returning 0 would
// have sailed through green and failed in Logic with the very error the gate
// was named after. A reviewer reads the commit title and the diff; only a
// reader who asks "and where is this value *checked*?" finds the hole.
//
// That question is mechanical. When a run claims to add a gate, every value
// it newly reports must be asserted somewhere — in this change or already in
// the tree. The trigger is the claim, not a file name, and the remedy is an
// assertion in the code, not a phrase in the report: the guard that had to be
// switched off (verifiedMetricEvidence) failed on both counts.
//
// A worker can dodge this by not claiming a gate. That is accepted: a false
// claim is what misleads the reader, and dropping it is the honest outcome.

/** The run says it is adding a gate, a guard, or a regression check. */
const GATE_CLAIM_RE =
  /\b(?:gate[sd]?\s+(?:on|against|for)|(?:add(?:s|ed)?|introduce[sd]?|new)\s+(?:a\s+|an\s+)?(?:regression\s+|ci\s+|qc\s+)?(?:gate|guard)|regression\s+(?:test|guard|gate|check|class)|guard(?:s|ed)?\s+against|prevents?\s+(?:a\s+|the\s+)?regression)\b|회귀\s*(?:테스트|게이트|가드|방지)|게이트\s*(?:추가|도입|신설)/i;

export function claimsGate(reportText: string): boolean {
  return GATE_CLAIM_RE.test(reportText);
}

/** `"key": expr`, `'key': expr`, `\"key\": expr` (a shell/Swift string building JSON). */
const QUOTED_KEY_RE = /["'`]([A-Za-z][A-Za-z0-9_]{2,40})\\?["'`]\s*:\s*([^,\n}]+)/g;
/** `obj["key"] = expr`. */
const INDEX_ASSIGN_RE = /\[\s*["'`]([A-Za-z][A-Za-z0-9_]{2,40})["'`]\s*\]\s*=\s*([^;\n]+)/g;

/** A value that is data, not a measurement: a literal, or a container opening. */
const LITERAL_VALUE_RE = /^\s*(?:["'`][^"'`]*["'`]|-?\d+(?:\.\d+)?|true|false|null|nil|undefined|None|\{\s*\}?|\[\s*\]?)\s*,?\s*\)?\s*$/;

/**
 * Keys every payload carries. A gate claim is never about these, and flagging
 * them would block every run that builds an object.
 */
const STRUCTURAL_KEYS = new Set([
  'type', 'name', 'id', 'key', 'value', 'values', 'error', 'errors', 'message', 'msg', 'status', 'state',
  'ts', 'timestamp', 'time', 'date', 'url', 'path', 'file', 'line', 'code', 'data', 'summary',
  'version', 'kind', 'stage', 'reason', 'detail', 'details', 'title', 'description', 'label', 'labels',
  'issue', 'task', 'options', 'config', 'args', 'env', 'cwd', 'source', 'target', 'output', 'result',
]);

/** Files that hold data or prose, where a `key: value` is never a measurement. */
const DATA_FILE_RE = /\.(?:json|jsonc|ya?ml|toml|md|mdx|txt|lock|csv|svg|html?)$/i;
const TEST_FILE_RE = /(?:^|\/)(?:__tests__|tests?|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|rb)$|Tests?\.swift$/;

/** Keys this change newly reports with a computed value, in file order, deduplicated. */
export function reportedKeys(files: ReadonlyArray<{ file: string; added: string }>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const { file, added } of files) {
    if (DATA_FILE_RE.test(file) || TEST_FILE_RE.test(file)) continue;
    for (const re of [QUOTED_KEY_RE, INDEX_ASSIGN_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(added)) !== null) {
        const key = m[1];
        if (seen.has(key) || STRUCTURAL_KEYS.has(key) || LITERAL_VALUE_RE.test(m[2])) continue;
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * Something that turns a value into a verdict: an assertion library, a
 * comparison, a shell test, a `jq -e`, a branch that throws or exits.
 */
const ASSERT_TOKEN_RE =
  /\b(?:assert\w*|expect|XCTAssert\w*|precondition|toBe\w*|toEqual|toStrictEqual|toContain\w*|toMatch\w*|toHave\w*|jq\s+-e|grep\s+-q|fail|panic|throw|exit\s+[1-9]|guard|unless)\b|\s-(?:eq|ne|lt|le|gt|ge)\s|===|!==|==|!=|<=|>=|\bif\s*[([]|\btest\s+-/;

/** How many lines above a mention of the key an enclosing assertion may open (a multi-line `expect(...).toEqual({...})`). */
const ASSERT_LOOKBACK_LINES = 12;

function bracketNet(line: string): number {
  let net = 0;
  for (const ch of line) {
    if (ch === '(' || ch === '{' || ch === '[') net += 1;
    else if (ch === ')' || ch === '}' || ch === ']') net -= 1;
  }
  return net;
}

/**
 * True when some mention of `key` in `text` sits inside an assertion: on the
 * same line, or inside a bracket an assertion line above opened and has not
 * closed. A comparison on the *previous* line is not an assertion of this one.
 */
export function assertsKey(text: string, key: string): boolean {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(key)) continue;
    if (ASSERT_TOKEN_RE.test(lines[i])) return true;
    let depth = 0;
    for (let j = i - 1; j >= 0 && j >= i - ASSERT_LOOKBACK_LINES; j -= 1) {
      depth += bracketNet(lines[j]);
      if (depth > 0 && ASSERT_TOKEN_RE.test(lines[j])) return true;
    }
  }
  return false;
}

/**
 * Pure verdict: given the added lines per file and a lookup for text elsewhere
 * in the tree that mentions a key, which reported keys does nothing assert.
 */
export function unassertedReportedKeys(
  files: ReadonlyArray<{ file: string; added: string }>,
  treeMentions: (key: string) => string,
): string[] {
  const allAdded = files.map((f) => f.added).join('\n');
  return reportedKeys(files).filter((key) => !assertsKey(allAdded, key) && !assertsKey(treeMentions(key), key));
}

export function gateClaimIssue(unasserted: string[]): string {
  return (
    `claims a gate or regression guard, but reports ${unasserted.length === 1 ? 'a value' : 'values'} nothing asserts: ` +
    unasserted.map((k) => `\`${k}\``).join(', ') +
    '. A reported value is not a gate — compare it to what the gate promises (an assert, a jq -e, a shell test) or stop reporting it.'
  );
}
