// The Supervisor's classic scripts stay under book.md Art. III's 1500 code LOC
// cap per file (AGT-4868). Code LOC = lines that are neither blank nor comment.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const JS = join(__dirname, '..', '..', 'web', 'static', 'js');
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
});
