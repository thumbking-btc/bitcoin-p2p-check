#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit, expect } from "@playwright/test";
import { assertPreviewUiState } from "./preview-ui-contract.mjs";

const baseUrl = process.env.PREVIEW_BASE_URL ?? "";
assert.match(baseUrl, /^https:\/\/[0-9a-f]{8}-bitcoin-p2p-check\.thumbking-btc\.workers\.dev$/u);
const report = { baseUrl, checks: [], failures: [] };
// Application assertions finish before screenshot capture: Playwright injects
// a WebKit-only `body {}` animation-sync stylesheet even with caret: initial.
// That diagnostic tool action must not be confused with application CSP errors.
const directory = "preview-browser-evidence";
await mkdir(directory, { recursive: true });

function readUiState() {
  const style = (selector) => {
    const element = document.querySelector(selector);
    return element ? getComputedStyle(element) : null;
  };
  const notice = document.querySelector("#deployment-environment-notice");
  return {
    cspViolations: window.__previewCspViolations ?? [],
    environment: document.documentElement.getAttribute("data-deployment-environment"),
    noticeVisible: !!notice && notice.getBoundingClientRect().height > 0 && !notice.hidden,
    theme: getComputedStyle(document.documentElement).getPropertyValue("--orange").trim(),
    bodyMargin: getComputedStyle(document.body).margin,
    stylesheets: [...document.styleSheets].filter((sheet) => {
      try { return !sheet.disabled && sheet.cssRules.length > 0; } catch { return false; }
    }).length,
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    roleDisplay: style(".role-options")?.display,
    formDisplay: style(".trade-form")?.display,
    cardPadding: parseFloat(style(".capture-card")?.paddingLeft ?? "0"),
    hydrated: !!document.querySelector(".trade-tool:not(.is-draft-hydrating)"),
  };
}

async function assertRendered(page, calculator = true, hydrated = true) {
  if (calculator && hydrated) {
    await page.waitForFunction(() => !!document.querySelector(".trade-tool:not(.is-draft-hydrating)"), null, { timeout: 15_000 });
  }
  if (calculator) await expect(page.locator(".role-options")).toHaveCSS("display", "grid", { timeout: 10_000 });
  await expect(page.locator("#deployment-environment-notice")).toBeVisible();
  const state = await page.evaluate(readUiState);
  assertPreviewUiState(state, { calculator, hydrated });
  return state;
}

async function newContext(browser, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    isMobile: (options.viewport?.width ?? 390) < 700, hasTouch: (options.viewport?.width ?? 390) < 700,
    serviceWorkers: "block", ...options,
  });
  await context.route("**/*", (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) return route.abort("blockedbyclient");
    return route.continue();
  });
  await context.addInitScript(() => {
    window.__previewCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__previewCspViolations.push({
        directive: event.effectiveDirective, blockedURI: event.blockedURI,
        sourceFile: event.sourceFile, lineNumber: event.lineNumber, sample: event.sample,
      });
    });
  });
  return context;
}

function trackPage(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("requestfailed", (request) => {
    if (request.url().includes("/_next/static/")) problems.push(`Asset failed: ${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on("response", (response) => {
    if (response.url().includes("/_next/static/") && ![200, 304].includes(response.status())) {
      problems.push(`Asset HTTP ${response.status()}: ${response.url()}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy|Refused to|MIME type/iu.test(message.text())) problems.push(message.text());
  });
  return problems;
}

function assertHtmlHeaders(response) {
  assert.ok(response, "Missing navigation response");
  assert.equal(response.status(), 200);
  const headers = response.headers();
  assert.equal(headers["x-deployment-environment"], "preview");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.match(headers["content-security-policy"] ?? "", /script-src[^;]*'self'/u);
  assert.doesNotMatch(headers["content-security-policy"] ?? "", /unsafe-inline/u);
  assert.match(headers["cache-control"] ?? "", /no-store/u);
}

async function runCase(name, operation) {
  try {
    const details = await operation();
    report.checks.push({ name, ok: true, ...details });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.failures.push({ name, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

try {
  const versionResponse = await fetch(`${baseUrl}/api/version`, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
  });
  assert.equal(versionResponse.status, 200);
  report.version = await versionResponse.json();
  assert.equal(report.version.deploymentEnvironment, "preview");
  assert.equal(report.version.workerVersion?.id?.slice(0, 8), new URL(baseUrl).hostname.slice(0, 8));

  for (const [engine, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await browserType.launch();
    try {
      for (const width of [320, 390, 1280]) {
        await runCase(`${engine}-${width}-online`, async () => {
          const context = await newContext(browser, { viewport: { width, height: 844 } });
          const page = await context.newPage();
          const problems = trackPage(page);
          try {
            assertHtmlHeaders(await page.goto(`${baseUrl}/`, { waitUntil: "load", timeout: 30_000 }));
            const state = await assertRendered(page);
            await page.locator('label[for="trade-role-seller"]').click();
            await expect(page.locator('label[for="trade-amount"]')).toHaveText("받을 원화");
            await page.locator('label[for="trade-role-buyer"]').click();
            await expect(page.locator('label[for="trade-amount"]')).toHaveText("보낼 원화");
            assert.deepEqual((await page.evaluate(readUiState)).cspViolations, [], "Application CSP violations");
            assert.deepEqual(problems, [], "Static asset or JavaScript failures");
            return { state };
          } finally {
            const finalState = await page.evaluate(readUiState).catch(() => null);
            await writeFile(`${directory}/${engine}-${width}-state.json`, JSON.stringify(finalState, null, 2));
            await page.screenshot({ path: `${directory}/${engine}-${width}.png`, fullPage: true, caret: "initial" }).catch(() => {});
            await context.close();
          }
        });
      }
      await runCase(`${engine}-secondary-routes-and-no-js`, async () => {
        const context = await newContext(browser, { javaScriptEnabled: false });
        const page = await context.newPage();
        try {
          for (const route of ["/", "/install/", "/privacy/", "/verify/"]) {
            assertHtmlHeaders(await page.goto(baseUrl + route, { waitUntil: "load", timeout: 30_000 }));
            await assertRendered(page, route === "/", false);
          }
        } finally { await context.close(); }
      });
      await runCase(`${engine}-missing-css-is-rejected`, async () => {
        const context = await newContext(browser);
        const page = await context.newPage();
        try {
          await page.goto(baseUrl, { waitUntil: "load", timeout: 30_000 });
          await assertRendered(page);
          await page.evaluate(() => {
            for (const sheet of document.styleSheets) sheet.disabled = true;
          });
          const broken = await page.evaluate(readUiState);
          assert.throws(() => assertPreviewUiState(broken), /stylesheet|CSS|theme|layout|padding/u);
          return { rejectedState: broken };
        } finally { await context.close(); }
      });
      await runCase(`${engine}-pwa-opt-in-${engine === "chromium" ? "offline-recovery" : "online-relaunch"}-opt-out`, async () => {
        const context = await newContext(browser, { serviceWorkers: "allow" });
        let page = await context.newPage();
        try {
          assertHtmlHeaders(await page.goto(baseUrl, { waitUntil: "load", timeout: 30_000 }));
          await assertRendered(page);
          assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
          await page.goto(`${baseUrl}/?pwa-review=1`, { waitUntil: "load", timeout: 30_000 });
          await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false), { timeout: 30_000 }).toBe(true);
          await assertRendered(page);
          let offlineEvidence = null;
          await page.close();
          if (engine === "chromium") {
            // Playwright documents service-worker network inspection/offline
            // instrumentation for Chromium. Do not claim iOS offline coverage.
            await context.setOffline(true);
            page = await context.newPage();
            const offline = await page.goto(baseUrl, { waitUntil: "load", timeout: 20_000 });
            assert.ok(offline?.fromServiceWorker(), "Offline shell was not served by the installed service worker");
            await assertRendered(page);
            const probe = await page.evaluate(async () => {
              try {
                await fetch(`/api/version?offline-probe=${Date.now()}`, {
                  cache: "no-store", signal: AbortSignal.timeout(5000),
                });
                return { networkBlocked: false, navigatorOnline: navigator.onLine };
              } catch {
                return { networkBlocked: true, navigatorOnline: navigator.onLine };
              }
            });
            // navigator.onLine describes an adapter, not whether the API is
            // reachable. Prove that the uncached request actually fails.
            assert.equal(probe.networkBlocked, true, "Offline API request unexpectedly succeeded");
            const cachedApiPaths = await page.evaluate(async () => {
              const requests = await Promise.all((await caches.keys()).map(async (key) => (await caches.open(key)).keys()));
              return requests.flat().map((request) => new URL(request.url).pathname).filter((pathname) => pathname.startsWith("/api/"));
            });
            assert.deepEqual(cachedApiPaths, [], "Financial/API responses must never be persisted in the shell cache");
            await page.screenshot({ path: `${directory}/${engine}-offline.png`, fullPage: true, caret: "initial" });
            offlineEvidence = { offlineFromServiceWorker: true, ...probe, cachedApiPaths };
            await context.setOffline(false);
          } else {
            page = await context.newPage();
          }
          await page.goto(baseUrl, { waitUntil: "load", timeout: 30_000 });
          await assertRendered(page);
          await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 10_000 }).toBe(true);
          await page.goto(`${baseUrl}/?pwa-review=0`, { waitUntil: "load", timeout: 30_000 });
          await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), { timeout: 10_000 }).toBe(0);
          await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter((key) => key.startsWith("bitcoin-p2p-check-")).length), { timeout: 10_000 }).toBe(0);
          return { offlineEvidence, onlineRelaunchControlled: true, iosStandaloneOfflineVerified: false };
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  }
} catch (error) {
  report.failures.push({ name: "preview-identity", error: error.message });
} finally {
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length > 0) process.exitCode = 1;
}
