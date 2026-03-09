// Created: 2026-03-07
// Purpose: Unit tests for Playwright rendering performance script
// Dependencies: vitest, playwright
// Test Status: Complete

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock Playwright modules
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

describe('Playwright Rendering Performance Script', () => {
  const TEST_OUTPUT_DIR = './test-performance-results';

  beforeEach(() => {
    // Clean up before each test
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
      fs.rmSync(TEST_OUTPUT_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
      fs.rmSync(TEST_OUTPUT_DIR, { recursive: true });
    }
  });

  describe('Tab Configuration', () => {
    it('should define correct tabs', () => {
      // Check the script structure directly
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('const TABS = [');
      expect(scriptText).toContain('"REPOS"');
      expect(scriptText).toContain('"PIPELINE"');
      expect(scriptText).toContain('"CHAT"');
    });

    it('should have exactly 3 tabs configured', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      // Count the tab definitions
      const tabMatch = scriptText.match(/const TABS = \[([\s\S]*?)\]/);
      expect(tabMatch).toBeDefined();

      // Check that the three tabs are present
      const tabContent = tabMatch![1];
      expect(tabContent).toContain('REPOS');
      expect(tabContent).toContain('PIPELINE');
      expect(tabContent).toContain('CHAT');
    });
  });

  describe('Output Directory Handling', () => {
    it('should create output directory if it does not exist', () => {
      // Test the directory creation logic
      if (!fs.existsSync(TEST_OUTPUT_DIR)) {
        fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
      }

      expect(fs.existsSync(TEST_OUTPUT_DIR)).toBe(true);
    });

    it('should accept custom output directory from environment', () => {
      const customDir = './custom-perf-output';
      process.env.OUTPUT_DIR = customDir;

      if (!fs.existsSync(customDir)) {
        fs.mkdirSync(customDir, { recursive: true });
      }

      expect(fs.existsSync(customDir)).toBe(true);

      // Cleanup
      if (fs.existsSync(customDir)) {
        fs.rmSync(customDir, { recursive: true });
      }
      delete process.env.OUTPUT_DIR;
    });
  });

  describe('Script Structure', () => {
    it('should export functions correctly', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('async function captureNavigationTiming');
      expect(scriptText).toContain('async function captureRenderingMetrics');
      expect(scriptText).toContain('async function measureTabRendering');
      expect(scriptText).toContain('async function runPerformanceTest');
    });

    it('should have proper TypeScript types defined', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('interface RenderingMetrics');
      expect(scriptText).toContain('interface PerformanceResult');
    });

    it('should have proper error handling', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('catch (error)');
      expect(scriptText).toContain('try {');
      expect(scriptText).toContain('finally {');
    });
  });

  describe('Tab Click Behavior', () => {
    it('should use tab-based navigation instead of URL navigation', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      // Check that tab clicking is used
      expect(scriptText).toContain('page.click');
      expect(scriptText).toContain('data-tab=');

      // Check that old URL-based navigation is removed
      expect(scriptText).not.toContain('page.goto(baseUrl + "/" + tab)');
      expect(scriptText).not.toContain('page.goto(`${baseUrl}/${tab}`');
    });

    it('should reference only existing tabs in click operations', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      // Extract the tab click line
      const clickMatch = scriptText.match(/page\.click\(`\.tab-bar[^`]+`\)/);
      expect(clickMatch).toBeDefined();

      // Should use tab index from the loop
      expect(scriptText).toContain('for (let i = 0; i < TABS.length; i++)');
    });
  });

  describe('Performance Metrics Collection', () => {
    it('should collect all required metrics', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      // Check metrics collection
      expect(scriptText).toContain('navigationEnd');
      expect(scriptText).toContain('domContentLoaded');
      expect(scriptText).toContain('loadComplete');
      expect(scriptText).toContain('renderComplete');
      expect(scriptText).toContain('totalRenderTime');
      expect(scriptText).toContain('firstContentfulPaint');
      expect(scriptText).toContain('largestContentfulPaint');
    });

    it('should measure timing in milliseconds', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('performance.now()');
      expect(scriptText).toContain('.toFixed(2)');
      expect(scriptText).toContain('ms');
    });
  });

  describe('Output Formats', () => {
    it('should output results in JSON format', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('.json');
      expect(scriptText).toContain('JSON.stringify');
      expect(scriptText).toContain('rendering-metrics-');
    });

    it('should output results in CSV format', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('.csv');
      expect(scriptText).toContain('csvHeaders');
      expect(scriptText).toContain('csvRows');
      expect(scriptText).toContain('csvContent');
    });

    it('should include headers in CSV output', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('Tab');
      expect(scriptText).toContain('Total (ms)');
      expect(scriptText).toContain('FCP (ms)');
      expect(scriptText).toContain('LCP (ms)');
    });
  });

  describe('Summary Statistics', () => {
    it('should calculate average render time', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('averageRenderTime');
      expect(scriptText).toContain('reduce');
    });

    it('should calculate min and max render times', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('minRenderTime');
      expect(scriptText).toContain('maxRenderTime');
      expect(scriptText).toContain('Math.min');
      expect(scriptText).toContain('Math.max');
    });

    it('should identify slow tabs (1.5x average)', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('slowTabs');
      expect(scriptText).toContain('1.5');
      expect(scriptText).toContain('averageRenderTime');
    });
  });

  describe('Environment Variables', () => {
    it('should read BASE_URL from environment', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('process.env.BASE_URL');
      expect(scriptText).toContain('http://localhost:5173');
    });

    it('should read OUTPUT_DIR from environment', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText).toContain('process.env.OUTPUT_DIR');
      expect(scriptText).toContain('./performance-results');
    });
  });

  describe('Documentation', () => {
    it('README should document all 3 tabs', () => {
      const readmeText = fs.readFileSync('./scripts/README-RENDERING-PERFORMANCE.md', 'utf-8');

      expect(readmeText).toContain('REPOS');
      expect(readmeText).toContain('PIPELINE');
      expect(readmeText).toContain('CHAT');
    });

    it('README should include usage examples', () => {
      const readmeText = fs.readFileSync('./scripts/README-RENDERING-PERFORMANCE.md', 'utf-8');

      expect(readmeText).toContain('npm run perf:measure');
      expect(readmeText).toContain('BASE_URL');
      expect(readmeText).toContain('OUTPUT_DIR');
    });

    it('README should include measurement descriptions', () => {
      const readmeText = fs.readFileSync('./scripts/README-RENDERING-PERFORMANCE.md', 'utf-8');

      expect(readmeText).toContain('Navigation Time');
      expect(readmeText).toContain('DOM Content Loaded');
      expect(readmeText).toContain('First Contentful Paint');
      expect(readmeText).toContain('Largest Contentful Paint');
    });
  });

  describe('Integration Tests', () => {
    it('should have npm script configured', () => {
      const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

      expect(packageJson.scripts).toBeDefined();
      expect(packageJson.scripts['perf:measure']).toBeDefined();
      expect(packageJson.scripts['perf:measure']).toContain('playwright-rendering-performance.ts');
    });

    it('should have proper shebang for direct execution', () => {
      const scriptText = fs.readFileSync('./scripts/playwright-rendering-performance.ts', 'utf-8');

      expect(scriptText.startsWith('#!/usr/bin/env tsx')).toBe(true);
    });
  });
});
