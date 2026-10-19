/** Non-visual performance samples; no screenshots or polish loop. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
const [base = 'http://localhost:3900', output] = process.argv.slice(2); assert(output, 'Usage: <preview-url> <evidence.json>');
const browser = await chromium.launch({ channel: 'chrome', headless: true }); const results = [];
try {
  for (const scenario of ['normal', 'stress']) {
    const samples = [];
    for (let trial = 0; trial < 5; trial++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await context.newPage();
      const start = performance.now(); await page.goto(`${base}/chat?demo=${scenario}`); await page.locator('[data-project="demo:000"]').waitFor();
      const renderMs = performance.now() - start;
      if (scenario === 'stress') { await page.locator('#project-load-more').click(); await page.locator('[data-project="demo:099"]').waitFor(); }
      const selected = performance.now(); await page.locator('[data-project="demo:000"]').click(); await page.locator('#channel-entries [data-entry]').first().waitFor();
      const selectionMs = performance.now() - selected;
      const session = await context.newCDPSession(page); await session.send('Performance.enable');
      const metrics = await session.send('Performance.getMetrics');
      samples.push({ renderMs, selectionMs, jsHeapUsedBytes: metrics.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value });
      await context.close();
    }
    results.push({ scenario, projects: scenario === 'stress' ? 100 : 10, agents: scenario === 'stress' ? 1000 : 100, samples });
  }
} finally { await browser.close(); }
await writeFile(output, JSON.stringify({ fixtureOnly: true, boundary: 'Local read-only demo data with the production UI; does not measure production API or fleet latency.', results }, null, 2));
console.log(JSON.stringify({ measured: results.length, trialsPerScale: 5 }));
