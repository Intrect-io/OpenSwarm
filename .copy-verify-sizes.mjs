import { readFileSync, statSync } from 'node:fs';

const files = [
  'src/discord/discordHandlers.ts',
  'src/discord/discordPair.ts',
  'src/runners/cliRunner.ts',
];

const srcRoot = '/work/OpenSwarm/src';
const dstRoot = '/work/OpenSwarm/worktree/c1f52155-1371-412d-973f-9a7855febc82/src';

for (const rel of files) {
  const src = `${srcRoot}/${rel.replace(/^src\//, '')}`;
  const dst = `${dstRoot}/${rel.replace(/^src\//, '')}`;
  const sb = readFileSync(src);
  const db = readFileSync(dst);
  const same = sb.equals(db);
  console.log(JSON.stringify({
    file: rel,
    srcBytes: sb.length,
    dstBytes: db.length,
    srcLines: sb.toString('utf8').split(/\n/).length - (sb[sb.length - 1] === 10 ? 1 : 0) || sb.toString('utf8').split('\n').length,
    // wc -l counts newline chars
    srcNewlines: sb.filter((b) => b === 0x0a).length,
    dstNewlines: db.filter((b) => b === 0x0a).length,
    identical: same,
  }));
}
