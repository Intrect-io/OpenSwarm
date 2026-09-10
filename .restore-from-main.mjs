import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
const WT = '/work/OpenSwarm/worktree/743ccc9e-7b29-4268-ad09-c64586dad683';
const MAIN = '/work/OpenSwarm/src';
const rel = 'automation/prProcessor.ts';
writeFileSync(`${WT}/src/${rel}`, readFileSync(`${MAIN}/${rel}`));
console.log('copied', rel);
