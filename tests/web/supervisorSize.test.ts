// The Supervisor's classic scripts stay under book.md Art. III's 1500 code LOC
// cap per file (AGT-4868). Code LOC = lines that are neither blank nor comment.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STATIC = join(__dirname, '..', '..', 'web', 'static');
const JS = join(STATIC, 'js');
const CAP = 1500;

function codeLoc(source: string): number {
  let inBlock = false;
  let count = 0;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    count++;
  }
  return count;
}

/**
 * Names a classic script declares at the top level. Both files share one global
 * scope, so a name declared in both would throw (let/const/class) or silently
 * shadow (function/var). Top-level statements start in column 0 in these files;
 * indented lines are inside a block. Destructuring and comma lists are covered.
 */
function topLevelNames(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split('\n')) {
    const fn = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line);
    if (fn) { names.push(fn[1]); continue; }
    const cls = /^class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (cls) { names.push(cls[1]); continue; }
    const decl = /^(?:let|var|const)\s+(.*)$/.exec(line);
    if (!decl) continue;
    const head = decl[1];
    if (/^[{[]/.test(head)) {
      // Destructuring: take the balanced pattern, then every bare identifier
      // that is not a property key (`h: i` binds i) or a default value.
      let depth = 0;
      let end = 0;
      for (; end < head.length; end++) {
        if ('{['.includes(head[end])) depth++;
        else if ('}]'.includes(head[end]) && --depth === 0) break;
      }
      const pattern = head.slice(0, end + 1).replace(/=\s*[^,}\]]+/g, '');
      for (const m of pattern.matchAll(/([A-Za-z_$][\w$]*)\s*(?=[,}\]])/g)) names.push(m[1]);
      continue;
    }
    // `a = 1, b = 2` — names at the start or after a comma at nesting depth 0.
    let depth = 0;
    let expectName = true;
    for (let i = 0; i < head.length; i++) {
      const c = head[i];
      if (expectName) {
        const m = /^\s*([A-Za-z_$][\w$]*)/.exec(head.slice(i));
        if (m) { names.push(m[1]); i += m[0].length - 1; }
        expectName = false;
      } else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === '"' || c === "'" || c === '`') {
        const end = head.indexOf(c, i + 1);
        if (end < 0) break;
        i = end;
      } else if (c === ',' && depth === 0) expectName = true;
      else if (c === ';' && depth === 0) break;
    }
  }
  return names;
}

describe('Supervisor script size', () => {
  it.each(['supervisor.js', 'supervisorPanels.js'])('%s is under the code LOC cap', (name) => {
    expect(codeLoc(readFileSync(join(JS, name), 'utf8'))).toBeLessThan(CAP);
  });

  it('supervisorPanels.js only declares, so loading it before supervisor.js is safe', () => {
    const topLevel = readFileSync(join(JS, 'supervisorPanels.js'), 'utf8')
      .split('\n')
      .filter((l) => /^[^\s}/)]/.test(l));
    for (const line of topLevel) {
      expect(line, line).toMatch(/^(?:async function|function|let|var|const) /);
    }
  });

  it('supervisor.html loads supervisorPanels.js before supervisor.js', () => {
    const html = readFileSync(join(STATIC, 'supervisor.html'), 'utf8');
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].split('/').pop());
    const panels = srcs.indexOf('supervisorPanels.js');
    const main = srcs.indexOf('supervisor.js');
    expect(panels, srcs.join(', ')).toBeGreaterThanOrEqual(0);
    expect(main, srcs.join(', ')).toBeGreaterThanOrEqual(0);
    expect(panels).toBeLessThan(main);
    expect(srcs.filter((s) => s === 'supervisor.js' || s === 'supervisorPanels.js')).toHaveLength(2);
  });

  it('supervisor.js and supervisorPanels.js declare no overlapping top-level names', () => {
    const main = topLevelNames(readFileSync(join(JS, 'supervisor.js'), 'utf8'));
    const panels = topLevelNames(readFileSync(join(JS, 'supervisorPanels.js'), 'utf8'));
    // Guard against a parser that silently finds nothing.
    expect(main.length).toBeGreaterThan(50);
    expect(panels.length).toBeGreaterThan(10);
    const mainSet = new Set(main);
    expect(panels.filter((n) => mainSet.has(n))).toEqual([]);
  });

  it('topLevelNames sees functions, classes, comma lists and destructuring', () => {
    const src = [
      'async function a() {}',
      'function* b() {}',
      'class C {}',
      'let d = f(1, 2), e = "x,y";',
      'const { g, h: i, j = 3 } = obj;',
      'var [k, l] = arr;',
      '  const nested = 1;',
    ].join('\n');
    expect(topLevelNames(src).sort()).toEqual(['C', 'a', 'b', 'd', 'e', 'g', 'i', 'j', 'k', 'l'].sort());
  });
});
