// Copy browser-side vendor files (xterm.js for the opt-in web terminal,
// AGT-4002) into dist/web-static/vendor. The dashboard loads no third-party
// CDN, so the terminal page needs these served from the daemon itself.
// Runs from postbuild after web/static has been copied.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const target = join('dist', 'web-static', 'vendor', 'xterm');
const files = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];

mkdirSync(target, { recursive: true });
let missing = 0;
for (const [from, name] of files) {
  if (!existsSync(from)) {
    missing += 1;
    console.warn(`[copy-web-vendor] missing ${from}; the web terminal page will not load`);
    continue;
  }
  copyFileSync(from, join(target, name));
}
if (missing === 0) console.log(`[copy-web-vendor] ${files.length} files -> ${target}`);
