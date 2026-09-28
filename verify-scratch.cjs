import fs from 'node:fs/promises';
import path from 'node:path';
const { executeTool } = await import('/Users/unohee/dev/OpenSwarm/verify-tools-bundle.cjs');
const TMP = await fs.mkdtemp('/tmp/verify-read-');
const call = (name, args) => ({ id: 't', function: { name, arguments: JSON.stringify(args) } });
let fail = 0;
const check = (label, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', label, extra); if (!cond) fail++; };

// 1. 512 MiB sparse file, small window
const sparse = path.join(TMP, 'huge.txt');
await fs.writeFile(sparse, 'first line\nsecond line\n');
const h = await fs.open(sparse, 'r+'); await h.truncate(512 * 1024 * 1024); await h.close();
const heapBefore = process.memoryUsage().heapUsed;
const r1 = await executeTool(call('read_file', { path: sparse, offset: 0, limit: 5 }), TMP);
const growth = process.memoryUsage().heapUsed - heapBefore;
check('sparse: no error', r1.is_error === false, r1.content.slice(0, 60));
check('sparse: has line1', r1.content.includes('1\tfirst line'));
check('sparse: bytes < 512KiB', Buffer.byteLength(r1.content) < 512 * 1024, `got ${Buffer.byteLength(r1.content)}`);
check('sparse: heap growth < 64MB', growth < 64 * 1024 * 1024, `${(growth / 1e6).toFixed(1)}MB`);

// 2. one huge line
const lineP = path.join(TMP, 'oneline.txt');
await fs.writeFile(lineP, 'x'.repeat(8 * 1024 * 1024) + '\ntail\n');
const r2 = await executeTool(call('read_file', { path: lineP, offset: 0, limit: 1 }), TMP);
check('oneline: capped', Buffer.byteLength(r2.content) < 300 * 1024, `got ${Buffer.byteLength(r2.content)}`);
check('oneline: says read cap', r2.content.includes('read cap'));

// 3. trailer exactness
const small = path.join(TMP, 'small.txt');
await fs.writeFile(small, Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
const r3 = await executeTool(call('read_file', { path: small, offset: 0, limit: 5 }), TMP);
check('small: window', r3.content.includes('5\tline5') && !r3.content.includes('6\tline6'));
check('small: trailer exact', r3.content.includes('(25 more lines)'), JSON.stringify(r3.content.slice(-30)));

const tiny = path.join(TMP, 'tiny.txt');
await fs.writeFile(tiny, 'a\nb\nc\n');
const r4 = await executeTool(call('read_file', { path: tiny }), TMP);
check('tiny: no trailer', r4.content === '1\ta\n2\tb\n3\tc', JSON.stringify(r4.content));

const noNL = path.join(TMP, 'nonl.txt');
await fs.writeFile(noNL, 'a\nb\nc');
check('noNL: whole', (await executeTool(call('read_file', { path: noNL }), TMP)).content === '1\ta\n2\tb\n3\tc');
check('noNL: window trailer', (await executeTool(call('read_file', { path: noNL, limit: 2 }), TMP)).content.includes('(1 more lines)'));
check('noNL: offset2', (await executeTool(call('read_file', { path: noNL, offset: 2 }), TMP)).content === '3\tc');

const utf = path.join(TMP, 'utf.txt');
await fs.writeFile(utf, '한'.repeat(22000) + '\nend\n');
const r5 = await executeTool(call('read_file', { path: utf, offset: 0, limit: 1 }), TMP);
check('utf8 across chunk boundary', r5.content.split('\n')[0] === `1\t${'한'.repeat(22000)}`);

// empty file
const empty = path.join(TMP, 'empty.txt');
await fs.writeFile(empty, '');
const r6 = await executeTool(call('read_file', { path: empty }), TMP);
check('empty file', r6.content === '' && r6.is_error === false, JSON.stringify(r6.content));

// existing suite sanity: offset/limit on a normal file
const normal = path.join(TMP, 'normal.txt');
await fs.writeFile(normal, 'alpha\nbeta\ngamma\ndelta\n');
const r7 = await executeTool(call('read_file', { path: normal, offset: 1, limit: 2 }), TMP);
check('offset/limit preserved', r7.content.includes('2\tbeta') && r7.content.includes('3\tgamma') && !r7.content.includes('1\talpha'));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
await fs.rm(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
