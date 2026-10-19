/** One batched visual/interaction pass; optional second pass only after fixes. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
const [origin = 'http://localhost:3900', destination = '.impeccable/review-project-collaboration'] = process.argv.slice(2);
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ channel: process.env.DASHBOARD_BROWSER === 'chromium' ? undefined : 'chrome', headless: true });
const results: unknown[] = [];
try {
  for (const width of [390, 1440, 720]) for (const theme of ['dark', 'light']) for (const path of ['/orchestration', '/chat']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, isMobile: width === 390, hasTouch: width === 390 });
    await context.addInitScript((theme) => { localStorage.setItem('openswarm.theme', theme); }, theme);
    const page = await context.newPage(); const errors: string[] = []; const writes: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await context.route('**/*', async (route) => {
      if (!['GET', 'HEAD'].includes(route.request().method())) { writes.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    const start = performance.now();
    await page.goto(`${origin}${path}?demo=normal`);
    await page.locator('[data-project="demo:000"]').waitFor();
    assert.equal(await page.locator('[data-project]').count(), 10);
    const initialMs = performance.now() - start;
    assert((await page.locator('#workspace-demo').innerText()).includes('Demo data · read only'));
    const checkReflow = async () => {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal overflow ${path}/${width}/${theme}`);
      const invalidVars = await page.evaluate(() => {
        const rule = document.querySelector('#workspace-refresh')!; const style = getComputedStyle(rule);
        return [style.color, style.backgroundColor, style.borderColor].some((v) => !v);
      }); assert.equal(invalidVars, false);
    };
    await checkReflow();
    const filename = `${path.slice(1)}-${width}-${theme}`;
    if (width !== 720) await page.screenshot({ path: resolve(destination, `${filename}-projects.png`), fullPage: true });
    const selectedAt = performance.now(); await page.locator('[data-project="demo:000"]').click();
    await page.locator('#channel-entries [data-entry]').first().waitFor();
    assert.equal(await page.locator('#workspace-message').isDisabled(), true);
    const selectMs = performance.now() - selectedAt;
    if (path === '/chat') {
      await page.locator('[data-thread]').last().click(); await page.locator('#thread-content h3').waitFor();
      assert((await page.locator('#thread-content').innerText()).includes('Existing discussion'));
    } else {
      await page.locator('[data-task="task-1"]').click(); await page.locator('#task-graph svg').waitFor();
      assert((await page.locator('#thread-content').innerText()).includes('Task relationships'));
      assert(await page.locator('#task-graph circle').count() <= 20); assert(await page.locator('#task-graph line').count() <= 40);
    }
    await checkReflow();
    if (width !== 720) await page.screenshot({ path: resolve(destination, `${filename}-detail.png`), fullPage: true });
    if (width <= 800) {
      await page.locator('#workspace-back').click(); assert.equal(await page.locator('[data-project-workspace]').getAttribute('data-level'), 'conversation');
      await page.locator('#workspace-back').click(); assert.equal(await page.locator('[data-project-workspace]').getAttribute('data-level'), 'projects');
    }
    await page.keyboard.press('Tab');
    const focusVisible = await page.evaluate(() => document.activeElement !== document.body);
    assert(focusVisible, 'Keyboard focus is reachable');
    const heap = await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    results.push({ path, width, theme, initialMs, selectMs, jsHeapBytes: heap, errors, writes, reflow: true,
      zoomBoundary: width === 720 ? '200% equivalent at 1440px: 720 CSS-pixel reflow' : null });
    await context.close();
  }
  for (const scenario of ['questions', 'busy', 'offline', 'stress']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${origin}/chat?demo=${scenario}`); await page.locator('[data-project="demo:000"]').waitFor();
    if (scenario === 'stress') { assert.equal(await page.locator('[data-project]').count(), 50); await page.locator('#project-load-more').click(); await page.locator('[data-project="demo:099"]').waitFor(); assert.equal(await page.locator('[data-project]').count(), 100); }
    if (scenario === 'offline') assert((await page.locator('#workspace-notice').innerText()).includes('Partial data'));
    await page.locator('[data-project="demo:000"]').click(); await page.locator('#channel-entries [data-entry]').first().waitFor();
    if (scenario === 'busy') { assert.equal(await page.locator('#channel-entries [data-entry]').count(), 50); await page.locator('#channel-older').click(); await page.waitForFunction(() => document.querySelectorAll('#channel-entries [data-entry]').length === 100); }
    if (scenario === 'questions') { await page.locator('#workspace-needs').click(); await page.locator('[data-need="question-1-2"]').click(); assert((await page.locator('#thread-content').innerText()).includes('هل نعتمد')); }
    assert.deepEqual(errors, []); results.push({ scenario, errors, boundary: 'Read-only demo fixture' }); await context.close();
  }
} finally { await browser.close(); }
await writeFile(resolve(destination, 'browser-results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ passed: results.length, captures: 16, destination }));
