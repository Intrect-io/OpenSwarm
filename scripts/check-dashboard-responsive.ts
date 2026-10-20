/** Read-only browser regression check against a running dashboard.
 * npx tsx scripts/check-dashboard-responsive.ts <base-url> <output-dir> [--live]
 * By default, preview this checkout's assets over the real backend. --live
 * checks the deployed assets. No non-GET request is allowed to reach it.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [baseUrl, outputDir, mode] = process.argv.slice(2);
assert(baseUrl && outputDir, 'Usage: <base-url> <output-dir> [--live]');
const origin = new URL(baseUrl).origin;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticRoot = resolve(root, 'web/static');
const paths = ['/', '/app', '/chat', '/orchestration', '/threads', '/warehouse', '/usage', '/settings'];
// Reference pages that scroll as documents rather than fit a console viewport.
const documentPages = new Set(['/warehouse', '/usage', '/settings']);
const results: object[] = [];
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.DASHBOARD_BROWSER === 'chromium' ? undefined : 'chrome', headless: true,
});
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    for (const theme of ['light', 'dark'] as const) {
      for (const path of paths) {
        const context = await browser.newContext({
          viewport: { width, height: 844 }, isMobile: width <= 768,
          hasTouch: width <= 1024, colorScheme: theme,
        });
        const errors: string[] = [];
        const blocked: string[] = [];
        await context.route('**/*', async (route) => {
          const request = route.request();
          if (!['GET', 'HEAD'].includes(request.method())) {
            blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
            await route.abort();
            return;
          }
          const url = new URL(request.url());
          if (url.origin !== origin || mode === '--live') return route.continue();
          if (url.pathname.startsWith('/static/')) {
            const file = resolve(staticRoot, url.pathname.slice('/static/'.length));
            assert(file.startsWith(`${staticRoot}/`));
            return route.fulfill({ path: file });
          }
          // Keep the document's real network address space. Fulfilling a
          // synthetic document makes Chrome block private-network API/SSE.
          return route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        const ready = page.waitForResponse((response) =>
          response.url().startsWith(`${origin}/api/`) && response.ok());
        await page.goto(`${origin}${path}`, { waitUntil: 'load' });
        await ready;
        // Let API-rendered content settle; SSE prevents networkidle by design.
        await page.waitForTimeout(700);
        const label = `${path === '/' ? 'supervisor' : path.slice(1)}-${width}-${theme}`;
        const size = await page.evaluate(() => ({
          inner: innerWidth, scroll: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }));
        assert.equal(size.inner, width, `${label}: mobile viewport expanded`);
        assert(size.scroll <= width + 1, `${label}: page overflow ${size.scroll}`);
        if (width >= 1024 && !documentPages.has(path)) {
          assert(size.height <= 845, `${label}: desktop panels escape the viewport (${size.height}px)`);
        }
        assert.deepEqual(errors, [], `${label}: JavaScript errors`);
        // The shared shell reserves exactly the header's height for every layout.
        const shell = await page.evaluate(() => ({
          header: Math.round(document.querySelector('header.topbar')!.getBoundingClientRect().height),
          reserved: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')),
          status: Boolean(document.querySelector('header.topbar > .shell-status')),
        }));
        assert(shell.status, `${label}: shell status line missing`);
        assert.equal(shell.reserved, shell.header, `${label}: --topbar-h ${shell.reserved} ≠ header ${shell.header}`);
        const nav = page.locator('.topbar-nav');
        assert(await nav.isVisible(), `${label}: navigation hidden`);
        const initialNavScroll = await nav.evaluate((element) => element.scrollLeft);
        for (const link of await nav.locator('a').all()) {
          await link.scrollIntoViewIfNeeded();
          const hit = await link.evaluate((element) => {
            const r = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          });
          assert(hit, `${label}: navigation link obscured`);
        }
        await nav.evaluate((element, left) => { element.scrollLeft = left; }, initialNavScroll);
        await page.locator('.nav-more summary').click();
        for (const link of await page.locator('.nav-more-menu a').all()) {
          assert(await link.isVisible(), label + ': More link hidden');
          assert(await link.evaluate(el => {
            const r = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          }), label + ': More link obscured');
        }
        await page.keyboard.press('Escape');
        assert(!await page.locator('.nav-more').evaluate(el => (el as HTMLDetailsElement).open), label + ': More does not close on Escape');
        if (path === '/threads' && width <= 800) {
          const detailPane = page.locator('.threads-detail');
          await page.waitForFunction(() => document.querySelector('#threads .thread-card') || document.querySelector('#threads .empty'));
          assert(!await detailPane.isVisible(), label + ': unselected detail takes mobile space');
          const firstThread = page.locator('.thread-card').first();
          assert(await firstThread.count(), label + ': needs an open thread to verify selection');
          await firstThread.click();
          await page.locator('#detail.visible').waitFor();
          assert(await detailPane.isVisible(), label + ': selected detail hidden');
          await page.locator('#new-thread-toggle').click();
          const form = page.locator('.new-thread');
          assert.equal(await page.locator('#new-thread-toggle').getAttribute('aria-expanded'), 'true');
          for (const field of await form.locator('input, textarea').all()) {
            assert(await field.evaluate(el => (el as HTMLInputElement).labels!.length > 0), label + ': compose field lacks label');
          }
          await form.locator('[name="subject"]').focus();
          const formBox = await form.boundingBox();
          const detailBox = await detailPane.boundingBox();
          assert(formBox && detailBox && detailBox.y >= formBox.y + formBox.height - 1, label + ': form/detail overlap');
          const filtered = page.waitForResponse(r => r.url().includes('/api/coordination/threads?') && r.url().includes('status=resolved'));
          await page.locator('#thread-status').selectOption('resolved');
          await filtered;
          await page.waitForFunction(() => !document.querySelector('#detail.visible'));
          assert(!await detailPane.isVisible(), label + ': filtered-out detail takes mobile space');
          await page.locator('#new-thread-cancel').click();
          const restored = page.waitForResponse(r => r.url().includes('/api/coordination/threads?') && r.url().includes('status=open'));
          await page.locator('#thread-status').selectOption('open');
          await restored;
          await page.waitForFunction(() => !document.querySelector('#threads .badge.resolved'));
        }
        if (path === '/orchestration' && width <= 900) {
          await page.locator('#thread').scrollIntoViewIfNeeded();
          const thread = await page.locator('#thread').boundingBox();
          assert(thread && thread.y >= 0 && thread.y < 844, `${label}: conversation unreachable`);
        }
        if (path === '/app' && width <= 900) {
          await page.locator('#sidebar-toggle').click();
          const header = await page.locator('.topbar').boundingBox();
          const sidebar = await page.locator('#sidebar').boundingBox();
          assert(header && sidebar && sidebar.y >= header.y + header.height - 1, `${label}: drawer overlaps navigation`);
          const pickerFont = await page.locator('.repo-picker select').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
          assert(pickerFont >= 16, `${label}: sidebar input text too small`);
          await page.locator('#sidebar-toggle').click();
        }
        if (path === '/chat' && width <= 768) {
          await page.setViewportSize({ width, height: 480 });
          await page.locator('.composer .textarea').focus();
          const composer = await page.locator('.composer').boundingBox();
          assert(composer && composer.y >= 0 && composer.y + composer.height <= 481, `${label}: composer clipped in a short viewport`);
          await page.setViewportSize({ width, height: 844 });
        }
        if (width <= 900) {
          const smallInputs = await page.locator('.input:visible, .select:visible, .textarea:visible').evaluateAll(
            (elements) => elements.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.id || el.className));
          assert.deepEqual(smallInputs, [], `${label}: input text too small`);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        if (width === 390 || width === 1440) {
          await page.screenshot({ path: resolve(outputDir, `${label}.png`), fullPage: true });
        }
        results.push({ page: path, width, theme, ...size, errors, blocked });
        console.log(`PASS ${label}`);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await writeFile(resolve(outputDir, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(`PASS ${results.length} responsive page checks`);
