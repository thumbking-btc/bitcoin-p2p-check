#!/usr/bin/env node
// Read-only diagnostics. This does not approve or deploy a preview.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium, webkit } from "@playwright/test";
import { extractReferencedAssets } from "./smoke-deployment.mjs";

const baseUrl = process.env.DIAGNOSTIC_PREVIEW_URL ?? "";
if (!/^https:\/\/[0-9a-f]{8}-bitcoin-p2p-check\.thumbking-btc\.workers\.dev$/u.test(baseUrl)) {
  throw new Error("An exact, allowlisted commit preview origin is required.");
}
const directory = "render-diagnostics";
await mkdir(directory, { recursive: true });
const report = { baseUrl, observedAt: new Date().toISOString(), http: [], browsers: [] };
const selectedHeaders = (headers) => Object.fromEntries([
  "content-type", "content-security-policy", "location", "cache-control", "etag",
  "x-deployment-environment", "x-content-type-options", "cross-origin-resource-policy",
  "content-encoding", "cf-cache-status", "vary",
].map((name) => [name, headers.get(name)]));

async function readResponse(url, accept) {
  const response = await fetch(url, {
    headers: { Accept: accept }, redirect: "manual", credentials: "omit",
    cache: "no-store", signal: AbortSignal.timeout(20_000),
  });
  const reader = response.body?.getReader();
  const chunks = [];
  let bytes = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) {
        void reader.cancel().catch(() => {});
        throw new Error("Diagnostic response exceeds 2 MB");
      }
      chunks.push(value);
    }
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return {
    url, status: response.status, headers: selectedHeaders(response.headers), bytes,
    sha256: createHash("sha256").update(body).digest("hex"), body,
  };
}

try {
  const version = await readResponse(`${baseUrl}/api/version`, "application/json");
  report.version = JSON.parse(version.body);
  if (version.status !== 200 || report.version.deploymentEnvironment !== "preview") {
    throw new Error("Diagnostics refuse any environment other than preview.");
  }
  for (const suffix of ["/", "/?pwa-review=1"]) {
    const root = await readResponse(`${baseUrl}${suffix}`, "text/html");
    const assets = extractReferencedAssets(root.body, root.url)
      .filter(({ mediaType }) => mediaType === "css" || mediaType === "javascript");
    report.http.push({ ...root, body: undefined, assets });
    await writeFile(`${directory}/${suffix === "/" ? "root" : "review"}.html`, root.body);
    if (assets.length > 32) throw new Error("Unexpected asset count");
    for (const asset of assets) {
      if (new URL(asset.url).origin !== baseUrl) throw new Error("Cross-origin asset");
      const result = await readResponse(asset.url, asset.mediaType === "css" ? "text/css" : "text/javascript");
      report.http.push({ ...result, body: undefined, sample: result.body.slice(0, 120) });
    }
  }
  for (const [name, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await browserType.launch();
    try {
      for (const suffix of ["/", "/?pwa-review=1"]) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
          isMobile: true, hasTouch: true, serviceWorkers: "block",
        });
        const result = { engine: name, suffix, errors: [], failed: [], responses: [] };
        report.browsers.push(result);
        await context.route("**/*", async (route) => {
          if (!["GET", "HEAD"].includes(route.request().method())) return route.abort("blockedbyclient");
          return route.continue();
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => result.errors.push(error.message.slice(0, 2000)));
        page.on("console", (message) => {
          if (message.type() === "error") result.errors.push(message.text().slice(0, 2000));
        });
        page.on("requestfailed", (request) => result.failed.push({
          url: request.url(), error: request.failure()?.errorText,
        }));
        page.on("response", (response) => {
          if (response.url().includes("/_next/static/")) result.responses.push({
            url: response.url(), status: response.status(), headers: response.headers(),
          });
        });
        await page.addInitScript(() => {
          window.__renderCspViolations = [];
          document.addEventListener("securitypolicyviolation", (event) => {
            window.__renderCspViolations.push({
              directive: event.effectiveDirective, blocked: event.blockedURI,
              policy: event.originalPolicy,
            });
          });
        });
        try {
          await page.goto(`${baseUrl}${suffix}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForTimeout(3000);
          result.document = await page.evaluate(() => {
            const elements = {};
            for (const selector of ["body", ".trade-tool", ".role-options", ".capture-card", ".trade-form", "#deployment-environment-notice"]) {
              const element = document.querySelector(selector);
              const style = element ? getComputedStyle(element) : null;
              elements[selector] = element ? {
                className: element.className, display: style.display,
                visibility: style.visibility, color: style.color,
                background: style.backgroundColor, padding: style.padding,
                width: element.getBoundingClientRect().width, hidden: element.hidden,
              } : null;
            }
            return {
              href: location.href, environment: document.documentElement.getAttribute("data-deployment-environment"),
              elements, scripts: [...document.scripts].filter((script) => script.src).map((script) => script.src),
              sheets: [...document.styleSheets].map((sheet) => {
                try { return { href: sheet.href, disabled: sheet.disabled, rules: sheet.cssRules.length }; }
                catch (error) { return { href: sheet.href, error: String(error) }; }
              }),
              csp: window.__renderCspViolations,
            };
          });
          await page.screenshot({ path: `${directory}/${name}-${suffix === "/" ? "root" : "review"}.png`, fullPage: true });
        } catch (error) {
          result.errors.push(String(error));
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
