/** Non-visual browser zoom proof. No screenshots or additional visual review. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
const [origin = 'http://localhost:3900', output] = process.argv.slice(2);
assert(output, 'Usage: <preview-url> <evidence.json>');
const results: Array<{ theme: string; factor: number; path: string; dimensions: {
  innerWidth: number; outerWidth: number; dpr: number; visualScale: number; scrollWidth: number;
}; detailReflow: boolean; keyboardReachable: boolean; errors: string[]; writes: string[] }> = [];
for (const theme of ['dark', 'light']) for (const factor of [1, 2]) {
  const profile = mkdtempSync(join(tmpdir(), 'project-browser-zoom-'));
  mkdirSync(join(profile, 'Default'));
  // Chromium stores the default partition's page zoom under x; runtime dimensions verify the factor.
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(factor) / Math.log(1.2) } } }));
  const browser = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: null, args: ['--window-size=1440,1000'] });
  try {
    await browser.addInitScript((value) => localStorage.setItem('openswarm.theme', value), theme);
    const page = await browser.newPage(); const errors: string[] = [], writes: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', async (route) => {
      if (!['GET', 'HEAD'].includes(route.request().method())) { writes.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    for (const path of ['/orchestration', '/chat']) {
      await page.goto(`${origin}${path}?demo=normal`);
      await page.locator('[data-project="demo:000"]').waitFor();
      const dimensions = await page.evaluate(() => ({ innerWidth, outerWidth, dpr: devicePixelRatio, visualScale: visualViewport!.scale, scrollWidth: document.documentElement.scrollWidth }));
      assert(dimensions.scrollWidth <= dimensions.innerWidth + 1);
      const baseline = results.find((r) => r.theme === theme && r.path === path && r.factor === 1);
      if (factor === 2) {
        assert(baseline); assert.equal(dimensions.outerWidth, baseline.dimensions.outerWidth);
        assert(Math.abs(dimensions.innerWidth * 2 - baseline.dimensions.innerWidth) <= 1);
        assert(Math.abs(dimensions.dpr / baseline.dimensions.dpr - 2) < 0.01); assert.equal(dimensions.visualScale, 1);
      }
      await page.locator('[data-project="demo:000"]').click(); await page.locator('#channel-entries [data-entry]').first().waitFor();
      if (path === '/chat') { await page.locator('[data-thread]').last().click(); await page.locator('#thread-content h3').waitFor(); }
      else { await page.locator('[data-task="task-1"]').click(); await page.locator('#task-graph svg').waitFor(); }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.keyboard.press('Tab'); assert(await page.evaluate(() => document.activeElement !== document.body));
      assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      results.push({ theme, factor, path, dimensions, detailReflow: true, keyboardReachable: true, errors: [...errors], writes: [...writes] });
    }
  } finally { await browser.close(); }
}
writeFileSync(output, JSON.stringify({ verifiedAt: new Date().toISOString(), screenshots: 0,
  methodSource: 'https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/browser/ui/zoom/chrome_zoom_level_prefs.cc',
  boundary: 'Non-visual DOM assertions with persistent Chrome page-zoom preferences; read-only demo, no manual visual pass.', results }, null, 2));
console.log(JSON.stringify({ passed: results.length, actualBrowserZoom: '100% and 200%', screenshots: 0 }));
