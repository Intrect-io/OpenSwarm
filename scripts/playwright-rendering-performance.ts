#!/usr/bin/env tsx
/**
 * Playwright 렌더링 성능 측정 스크립트
 * 모든 프론트엔드 탭을 순회하며 렌더링 완료까지의 시간을 측정합니다.
 *
 * Created: 2026-03-07
 * Purpose: 프론트엔드 성능 분석을 위한 렌더링 시간 데이터 수집
 * Dependencies: playwright, node:fs, node:path
 */

import { chromium, type Browser, type Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

// 탭 정의 (실제 OpenSwarm 대시보드 구조에 맞게 수정)
const TABS = [
  "REPOS",
  "PIPELINE",
  "CHAT",
] as const;

type Tab = (typeof TABS)[number];

interface RenderingMetrics {
  tab: Tab;
  startTime: number;
  navigationEnd: number;
  domContentLoaded: number;
  loadComplete: number;
  renderComplete: number;
  totalRenderTime: number;
  // 성능 Navigation API 메트릭
  navigationTiming?: {
    domContentLoadedEventEnd: number;
    loadEventEnd: number;
    navigationStart: number;
  };
  // 첫 렌더링 관련 메트릭
  firstPaint?: number;
  firstContentfulPaint?: number;
  largestContentfulPaint?: number;
}

interface PerformanceResult {
  tabs: RenderingMetrics[];
  summary: {
    averageRenderTime: number;
    minRenderTime: number;
    maxRenderTime: number;
    totalTime: number;
    timestamp: string;
  };
}

async function captureNavigationTiming(page: Page): Promise<any> {
  return await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    return {
      navigationStart: navigation.startTime,
      domContentLoadedEventEnd:
        (navigation as PerformanceNavigationTiming).domContentLoadedEventEnd,
      loadEventEnd: (navigation as PerformanceNavigationTiming).loadEventEnd,
    };
  });
}

async function captureRenderingMetrics(page: Page): Promise<{
  firstPaint?: number;
  firstContentfulPaint?: number;
  largestContentfulPaint?: number;
}> {
  return await page.evaluate(() => {
    const paintEntries = performance.getEntriesByType("paint");
    const paintMap = new Map(paintEntries.map((e) => [e.name, e.startTime]));

    const lcpEntries = performance.getEntriesByType(
      "largest-contentful-paint"
    );
    const lcp =
      lcpEntries.length > 0
        ? lcpEntries[lcpEntries.length - 1].startTime
        : undefined;

    return {
      firstPaint: paintMap.get("first-paint"),
      firstContentfulPaint: paintMap.get("first-contentful-paint"),
      largestContentfulPaint: lcp,
    };
  });
}

async function measureTabRendering(
  page: Page,
  tab: Tab,
  tabIndex: number
): Promise<RenderingMetrics> {
  const startTime = performance.now();

  console.log(`📊 Measuring: ${tab} (Tab ${tabIndex})`);

  // 탭 버튼 클릭 (탭 전환)
  await page.click(`.tab-bar .tab[data-tab="${tabIndex}"]`);

  const navigationEnd = performance.now();

  // 렌더링 완료 대기 (DOM 안정화)
  await page.waitForTimeout(200);

  // DOM 콘텐츠 로드 완료 대기
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  const domContentLoaded = performance.now();

  // 로드 이벤트 완료 대기
  await page.waitForLoadState("load").catch(() => {});

  const loadComplete = performance.now();

  // 추가 렌더링 대기 (리플로우/리페인트 완료)
  await page.waitForTimeout(500);

  const renderComplete = performance.now();

  // 성능 메트릭 수집
  const navigationTiming = await captureNavigationTiming(page);
  const renderingMetrics = await captureRenderingMetrics(page);

  const totalRenderTime = renderComplete - startTime;

  return {
    tab,
    startTime,
    navigationEnd: navigationEnd - startTime,
    domContentLoaded: domContentLoaded - startTime,
    loadComplete: loadComplete - startTime,
    renderComplete: renderComplete - startTime,
    totalRenderTime,
    navigationTiming,
    ...renderingMetrics,
  };
}

async function runPerformanceTest(
  baseUrl: string,
  outputDir: string = "./performance-results"
): Promise<void> {
  let browser: Browser | null = null;

  try {
    console.log("🚀 Playwright 렌더링 성능 측정 시작\n");
    console.log(`Base URL: ${baseUrl}`);
    console.log(`Output Directory: ${outputDir}\n`);

    // 출력 디렉토리 생성
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 브라우저 시작
    browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    const results: RenderingMetrics[] = [];
    const overallStartTime = performance.now();

    // 먼저 대시보드 페이지 로드 (병목 분석을 위해 상세 로깅 추가)
    console.log(`🌐 Loading dashboard: ${baseUrl}`);
    const pageLoadStartTime = performance.now();

    // 네트워크 요청 모니터링
    let totalRequests = 0;
    let completedRequests = 0;
    const requestDetails: { url: string; status: number; duration: number }[] = [];

    page.on('request', (request) => {
      totalRequests++;
    });

    page.on('response', (response) => {
      completedRequests++;
      const url = response.url();
      requestDetails.push({
        url,
        status: response.status(),
        duration: 0
      });
    });

    try {
      await page.goto(baseUrl, { waitUntil: "load", timeout: 60000 });
    } catch (e) {
      console.warn(`⚠️  Page load timeout after 60s, continuing with available content...`);
    }

    const pageLoadEndTime = performance.now();
    const pageLoadTime = pageLoadEndTime - pageLoadStartTime;
    console.log(`✅ Dashboard loaded in ${pageLoadTime.toFixed(2)}ms`);
    console.log(`   Completed requests: ${completedRequests}/${totalRequests}\n`);

    // 각 탭의 렌더링 시간 측정
    for (let i = 0; i < TABS.length; i++) {
      const tab = TABS[i];
      try {
        const metrics = await measureTabRendering(page, tab, i);
        results.push(metrics);

        console.log(
          `  ✅ Complete: ${tab} - ${metrics.totalRenderTime.toFixed(2)}ms`
        );
        if (metrics.firstContentfulPaint) {
          console.log(
            `     FCP: ${metrics.firstContentfulPaint.toFixed(2)}ms`
          );
        }
        if (metrics.largestContentfulPaint) {
          console.log(
            `     LCP: ${metrics.largestContentfulPaint.toFixed(2)}ms`
          );
        }
      } catch (error) {
        console.error(`  ❌ Error measuring ${tab}:`, error);
        results.push({
          tab,
          startTime: 0,
          navigationEnd: 0,
          domContentLoaded: 0,
          loadComplete: 0,
          renderComplete: 0,
          totalRenderTime: -1, // 실패를 나타내는 음수값
        });
      }
    }

    const overallEndTime = performance.now();
    const validResults = results.filter((r) => r.totalRenderTime > 0);

    // 요약 통계 계산
    const renderTimes = validResults.map((r) => r.totalRenderTime);
    const averageRenderTime =
      renderTimes.length > 0
        ? renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length
        : 0;
    const minRenderTime = renderTimes.length > 0 ? Math.min(...renderTimes) : 0;
    const maxRenderTime = renderTimes.length > 0 ? Math.max(...renderTimes) : 0;

    const performanceResult: PerformanceResult = {
      tabs: results,
      summary: {
        averageRenderTime,
        minRenderTime,
        maxRenderTime,
        totalTime: overallEndTime - overallStartTime,
        timestamp: new Date().toISOString(),
      },
    };

    // 결과 저장
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonFile = path.join(outputDir, `rendering-metrics-${timestamp}.json`);
    const csvFile = path.join(outputDir, `rendering-metrics-${timestamp}.csv`);

    fs.writeFileSync(jsonFile, JSON.stringify(performanceResult, null, 2));
    console.log(`\n✅ JSON Report: ${jsonFile}`);

    // CSV 형식으로도 저장
    const csvHeaders = [
      "Tab",
      "Total (ms)",
      "Navigation (ms)",
      "DOMContentLoaded (ms)",
      "Load Complete (ms)",
      "Render Complete (ms)",
      "FCP (ms)",
      "LCP (ms)",
    ];
    const csvRows = results.map((r) => [
      r.tab,
      r.totalRenderTime.toFixed(2),
      r.navigationEnd.toFixed(2),
      r.domContentLoaded.toFixed(2),
      r.loadComplete.toFixed(2),
      r.renderComplete.toFixed(2),
      r.firstContentfulPaint?.toFixed(2) || "N/A",
      r.largestContentfulPaint?.toFixed(2) || "N/A",
    ]);

    const csvContent =
      csvHeaders.join(",") +
      "\n" +
      csvRows.map((row) => row.join(",")).join("\n");
    fs.writeFileSync(csvFile, csvContent);
    console.log(`✅ CSV Report: ${csvFile}`);

    // 요약 출력
    console.log("\n📈 성능 요약:");
    console.log(`  평균 렌더링 시간: ${averageRenderTime.toFixed(2)}ms`);
    console.log(`  최소 렌더링 시간: ${minRenderTime.toFixed(2)}ms (${validResults.find((r) => r.totalRenderTime === minRenderTime)?.tab})`);
    console.log(`  최대 렌더링 시간: ${maxRenderTime.toFixed(2)}ms (${validResults.find((r) => r.totalRenderTime === maxRenderTime)?.tab})`);
    console.log(
      `  전체 테스트 시간: ${performanceResult.summary.totalTime.toFixed(2)}ms`
    );
    console.log(`  성공한 탭: ${validResults.length}/${results.length}`);

    // 성능 문제가 있는 탭 표시
    const slowTabs = validResults.filter((r) => r.totalRenderTime > averageRenderTime * 1.5);
    if (slowTabs.length > 0) {
      console.log("\n⚠️  성능 문제 탭 (평균의 1.5배 이상):");
      slowTabs.forEach((tab) => {
        console.log(
          `  - ${tab.tab}: ${tab.totalRenderTime.toFixed(2)}ms`
        );
      });
    }

    await context.close();
  } catch (error) {
    console.error("❌ 테스트 중 오류 발생:", error);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// 메인 실행
const baseUrl = process.env.BASE_URL || "http://localhost:5173";
const outputDir = process.env.OUTPUT_DIR || "./performance-results";

runPerformanceTest(baseUrl, outputDir).then(() => {
  console.log("\n🎉 렌더링 성능 측정 완료");
  process.exit(0);
});
