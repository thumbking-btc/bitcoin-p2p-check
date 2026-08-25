import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeBaseUrl,
  parseSmokeOptions,
  runDeploymentSmoke,
  SMOKE_ENDPOINTS,
  validateVersionPayload,
} from "../scripts/smoke-deployment.mjs";

const STATIC_CACHE = "public, max-age=0, must-revalidate";
const NO_STORE = "no-store";
const CSP = "default-src 'self'; script-src 'self' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; object-src 'none'; frame-ancestors 'none'";
const STATIC_SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=()",
};

function responseFor(url) {
  if (["/", "/install/", "/privacy/", "/verify/"].includes(url.pathname)) {
    return new Response("<!doctype html>", {
      status: 200,
      headers: { ...STATIC_SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": STATIC_CACHE, "Content-Security-Policy": CSP },
    });
  }
  if (url.pathname === "/sw.js") {
    return new Response("// service worker", {
      headers: { ...STATIC_SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": NO_STORE, "Service-Worker-Allowed": "/" },
    });
  }
  if (url.pathname === "/api/version") {
    return Response.json({ ok: true, appVersion: "2.3.0", workerVersion: null }, { headers: { "Cache-Control": NO_STORE } });
  }
  if (url.pathname === "/api/market" && url.search === "?price=0") {
    return Response.json({ status: "partial" }, { headers: { "Cache-Control": NO_STORE } });
  }
  return Response.json({ ok: false, code: "NOT_FOUND", message: "Not found" }, {
    status: 404,
    headers: { "Cache-Control": NO_STORE },
  });
}

test("deployment smoke uses only bounded, read-only GET requests, including a nonexistent record lookup", async () => {
  const calls = [];
  const results = await runDeploymentSmoke({
    baseUrl: "https://deployment.example",
    timeoutMs: 100,
    log() {},
    async fetcher(input, init) {
      const url = new URL(input);
      calls.push({ url: `${url.pathname}${url.search}`, init });
      return responseFor(url);
    },
  });

  assert.equal(results.length, SMOKE_ENDPOINTS.length);
  assert.deepEqual(calls.map((call) => call.url), SMOKE_ENDPOINTS.map((endpoint) => endpoint.path));
  assert.ok(calls.every((call) => call.init.method === "GET"));
  assert.ok(calls.every((call) => call.init.redirect === "manual"));
  assert.ok(calls.every((call) => call.init.credentials === "omit"));
  assert.ok(calls.every((call) => call.init.signal instanceof AbortSignal));
  assert.ok(calls.every((call) => !Object.hasOwn(call.init, "body")));
  assert.equal(calls.filter((call) => call.url.startsWith("/api/trade-record/")).length, 1);
  assert.equal(calls.find((call) => call.url.startsWith("/api/trade-record/"))?.init.method, "GET");
});

test("deployment smoke rejects missing API no-store protection", async () => {
  await assert.rejects(
    runDeploymentSmoke({
      baseUrl: "https://deployment.example",
      timeoutMs: 100,
      log() {},
      async fetcher(input) {
        const url = new URL(input);
        if (url.pathname === "/api/market") {
          return Response.json({}, { headers: { "Cache-Control": "public, max-age=60" } });
        }
        return responseFor(url);
      },
    }),
    /no-store/u,
  );
});

test("deployment smoke aborts a request at the configured timeout", async () => {
  await assert.rejects(
    runDeploymentSmoke({
      baseUrl: "https://deployment.example",
      timeoutMs: 10,
      log() {},
      fetcher(_input, init) {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      },
    }),
    /10ms 안에 완료되지 않았습니다/u,
  );
});

test("BASE_URL parsing accepts CLI or environment input and rejects unsafe origins", () => {
  assert.deepEqual(parseSmokeOptions([], { BASE_URL: "https://deployment.example", SMOKE_TIMEOUT_MS: "250" }), {
    help: false,
    baseUrl: "https://deployment.example",
    timeoutMs: 250,
  });
  assert.equal(parseSmokeOptions(["https://cli.example"], { BASE_URL: "https://environment.example" }).baseUrl, "https://cli.example");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeBaseUrl("http://deployment.example"), /HTTPS/u);
  assert.throws(() => normalizeBaseUrl("https://user:secret@deployment.example"), /비밀번호/u);
  assert.throws(() => normalizeBaseUrl("https://deployment.example/subpath"), /경로/u);
});

test("deployment smoke can bind release expectations to Worker version metadata", async () => {
  const expectedWorkerTag = "a".repeat(40);
  await assert.rejects(
    runDeploymentSmoke({
      baseUrl: "https://deployment.example",
      timeoutMs: 100,
      expectedAppVersion: "2.3.0",
      expectedWorkerTag,
      log() {},
      async fetcher(input) {
        const url = new URL(input);
        if (url.pathname === "/api/version") {
          return Response.json({
            ok: true,
            appVersion: "2.3.0",
            workerVersion: { id: "worker-version-id", tag: "wrong-sha", timestamp: new Date().toISOString() },
          }, { headers: { "Cache-Control": NO_STORE } });
        }
        return responseFor(url);
      },
    }),
    /Worker tag가 다릅니다/u,
  );

  assert.throws(
    () => validateVersionPayload({ ok: true, appVersion: "2.3.0", workerVersion: null }, { expectedWorkerTag }),
    /Worker tag가 다릅니다/u,
  );
});
