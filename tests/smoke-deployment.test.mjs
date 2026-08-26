import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCssReferencedAssets,
  extractJavaScriptReferencedAssets,
  extractManifestReferencedAssets,
  extractReferencedAssets,
  extractServiceWorkerReferencedAssets,
  createVersionOverrideHeader,
  normalizeBaseUrl,
  parseSmokeOptions,
  readSmallText,
  runDeploymentSmoke,
  SMOKE_ENDPOINTS,
  validateReferencedAssetResponse,
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

async function settleWithin(promise, timeoutMs = 100) {
  const didNotSettle = Symbol("did-not-settle");
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(didNotSettle), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function bodyWithStalledCancellation(onCancel) {
  return new ReadableStream({
    cancel() {
      onCancel();
      return new Promise(() => {});
    },
  });
}

function responseFor(url) {
  if (["/", "/install/", "/privacy/", "/verify/"].includes(url.pathname)) {
    const html = url.pathname === "/"
      ? '<!doctype html><link rel="stylesheet" href="/_next/static/app.css"><link rel="manifest" href="/manifest.webmanifest"><script src="/_next/static/app.js"></script>'
      : "<!doctype html>";
    return new Response(html, {
      status: 200,
      headers: {
        ...STATIC_SECURITY_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": STATIC_CACHE,
        "Content-Security-Policy": CSP,
        "X-Deployment-Environment": "production",
      },
    });
  }
  if (url.pathname === "/_next/static/app.css") {
    return new Response("body{}", {
      headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  }
  if (url.pathname === "/_next/static/app.js") {
    return new Response("export{}", {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  }
  if (url.pathname === "/manifest.webmanifest") {
    return new Response('{"icons":[]}', {
      headers: {
        "Content-Type": "application/manifest+json",
        "Cache-Control": STATIC_CACHE,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (url.pathname === "/sw.js") {
    return new Response('const APP_SHELL = ["/"];', {
      headers: { ...STATIC_SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": NO_STORE, "Service-Worker-Allowed": "/" },
    });
  }
  if (url.pathname === "/api/version") {
    return Response.json({
      ok: true,
      appVersion: "2.3.0",
      deploymentEnvironment: "production",
      workerVersion: null,
    }, { headers: { "Cache-Control": NO_STORE, "X-Deployment-Environment": "production" } });
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

  assert.equal(results.length, SMOKE_ENDPOINTS.length + 4);
  assert.deepEqual(
    calls.filter((call) => !call.url.startsWith("/_next/static/")).map((call) => call.url),
    [...SMOKE_ENDPOINTS.map((endpoint) => endpoint.path), "/manifest.webmanifest", "/api/version"],
  );
  assert.deepEqual(
    calls.filter((call) => call.url.startsWith("/_next/static/")).map((call) => call.url).sort(),
    ["/_next/static/app.css", "/_next/static/app.js"],
  );
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

test("deployment smoke does not await stalled endpoint body cancellation", async () => {
  let cancelled = false;
  const results = await settleWithin(runDeploymentSmoke({
    baseUrl: "https://deployment.example",
    timeoutMs: 100,
    log() {},
    async fetcher(input) {
      const url = new URL(input);
      if (url.pathname === "/api/market") {
        return new Response(bodyWithStalledCancellation(() => {
          cancelled = true;
        }), {
          headers: { "Content-Type": "application/json", "Cache-Control": NO_STORE },
        });
      }
      return responseFor(url);
    },
  }));

  assert.ok(Array.isArray(results), "endpoint body cancel이 완료되지 않아 smoke가 멈췄습니다.");
  assert.equal(cancelled, true);
});

test("small text reader enforces the byte limit while streaming without awaiting stalled cancellation", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(9));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  }));

  await assert.rejects(
    settleWithin(readSmallText(response, 16)),
    /16 bytes를 초과/u,
  );
  assert.equal(cancelled, true);
});

test("small text reader preserves UTF-8 characters split across stream chunks", async () => {
  const encoded = new TextEncoder().encode("가");
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.slice(0, 1));
      controller.enqueue(encoded.slice(1));
      controller.close();
    },
  }));

  assert.equal(await readSmallText(response, encoded.byteLength), "가");
});

test("small text reader rejects an oversized Content-Length without reading or awaiting cancellation", async () => {
  let cancelled = false;
  const response = new Response(bodyWithStalledCancellation(() => {
    cancelled = true;
  }), { headers: { "Content-Length": "17" } });

  await assert.rejects(
    settleWithin(readSmallText(response, 16)),
    /16 bytes를 초과/u,
  );
  assert.equal(cancelled, true);
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
  assert.equal(
    parseSmokeOptions(["--expected-environment", "staging", "https://deployment.example"], {}).expectedDeploymentEnvironment,
    "staging",
  );
  assert.throws(
    () => parseSmokeOptions(["--expected-environment=qa", "https://deployment.example"], {}),
    /production, staging 또는 preview/u,
  );
  assert.deepEqual(parseSmokeOptions(["https://deployment.example"], {
    SMOKE_WORKER_VERSION_OVERRIDE_NAME: "bitcoin-p2p-check",
    SMOKE_WORKER_VERSION_OVERRIDE_ID: "12345678-1234-4abc-8def-1234567890ab",
  }), {
    help: false,
    baseUrl: "https://deployment.example",
    timeoutMs: 10_000,
    workerVersionOverrideName: "bitcoin-p2p-check",
    workerVersionOverrideId: "12345678-1234-4abc-8def-1234567890ab",
  });
  assert.throws(
    () => parseSmokeOptions(["https://deployment.example"], {
      SMOKE_WORKER_VERSION_OVERRIDE_NAME: "bitcoin-p2p-check",
    }),
    /함께 지정/u,
  );
  assert.equal(
    createVersionOverrideHeader("bitcoin-p2p-check", "12345678-1234-4abc-8def-1234567890ab"),
    'bitcoin-p2p-check="12345678-1234-4abc-8def-1234567890ab"',
  );
  assert.throws(
    () => createVersionOverrideHeader("bad,name", "12345678-1234-4abc-8def-1234567890ab"),
    /Worker 이름/u,
  );
});

test("deployment smoke sends the exact version override on every endpoint and asset request", async () => {
  const versionId = "12345678-1234-4abc-8def-1234567890ab";
  const calls = [];
  await runDeploymentSmoke({
    baseUrl: "https://deployment.example",
    timeoutMs: 100,
    workerVersionOverrideName: "bitcoin-p2p-check",
    workerVersionOverrideId: versionId,
    log() {},
    async fetcher(input, init) {
      calls.push(init.headers["Cloudflare-Workers-Version-Overrides"]);
      return responseFor(new URL(input));
    },
  });
  assert.ok(calls.length > SMOKE_ENDPOINTS.length);
  assert.deepEqual(new Set(calls), new Set([`bitcoin-p2p-check="${versionId}"`]));
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
            deploymentEnvironment: "production",
            workerVersion: { id: "worker-version-id", tag: "wrong-sha", timestamp: new Date().toISOString() },
          }, { headers: { "Cache-Control": NO_STORE, "X-Deployment-Environment": "production" } });
        }
        return responseFor(url);
      },
    }),
    /Worker tag가 다릅니다/u,
  );

  assert.throws(
    () => validateVersionPayload({
      ok: true,
      appVersion: "2.3.0",
      deploymentEnvironment: "production",
      workerVersion: null,
    }, { expectedWorkerTag }),
    /Worker tag가 다릅니다/u,
  );
});

test("deployment smoke rejects a missing JavaScript chunk referenced by root HTML", async () => {
  await assert.rejects(
    runDeploymentSmoke({
      baseUrl: "https://deployment.example",
      timeoutMs: 100,
      log() {},
      async fetcher(input) {
        const url = new URL(input);
        if (url.pathname === "/_next/static/app.js") {
          return new Response("missing", {
            status: 404,
            headers: { "Content-Type": "text/plain", "Cache-Control": NO_STORE },
          });
        }
        return responseFor(url);
      },
    }),
    /app\.js.*예상 상태 200, 실제 상태 404/u,
  );
});

test("deployment smoke does not await stalled referenced asset body cancellation", async () => {
  let cancelled = false;
  const results = await settleWithin(runDeploymentSmoke({
    baseUrl: "https://deployment.example",
    timeoutMs: 100,
    log() {},
    async fetcher(input) {
      const url = new URL(input);
      if (url.pathname === "/manifest.webmanifest") {
        return new Response('{"icons":[{"src":"/stalled-icon.png"}]}', {
          headers: {
            "Content-Type": "application/manifest+json",
            "Cache-Control": STATIC_CACHE,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (url.pathname === "/stalled-icon.png") {
        return new Response(bodyWithStalledCancellation(() => {
          cancelled = true;
        }), {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": STATIC_CACHE,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      return responseFor(url);
    },
  }));

  assert.ok(Array.isArray(results), "asset body cancel이 완료되지 않아 smoke가 멈췄습니다.");
  assert.equal(cancelled, true);
});

test("deployment smoke derives staging policy from version metadata", async () => {
  const results = await runDeploymentSmoke({
    baseUrl: "https://staging.example",
    timeoutMs: 100,
    expectedDeploymentEnvironment: "staging",
    log() {},
    async fetcher(input) {
      const url = new URL(input);
      if (url.pathname === "/api/version") {
        return Response.json({
          ok: true,
          appVersion: "2.3.0",
          deploymentEnvironment: "staging",
          workerVersion: null,
        }, { headers: { "Cache-Control": NO_STORE, "X-Deployment-Environment": "staging" } });
      }
      const response = responseFor(url);
      if (!response.headers.get("content-type")?.startsWith("text/html")) return response;
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      headers.set("X-Deployment-Environment", "staging");
      headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      return new Response(await response.text(), { status: response.status, headers });
    },
  });
  assert.ok(results.some((result) => result.endpoint?.path === "/"));
});

test("deployment smoke rejects a deployment version that changes during recursive validation", async () => {
  let versionRequests = 0;
  await assert.rejects(
    runDeploymentSmoke({
      baseUrl: "https://deployment.example",
      timeoutMs: 100,
      log() {},
      async fetcher(input) {
        const url = new URL(input);
        if (url.pathname !== "/api/version") return responseFor(url);
        versionRequests += 1;
        return Response.json({
          ok: true,
          appVersion: "2.3.0",
          deploymentEnvironment: "production",
          workerVersion: {
            id: `worker-version-${versionRequests}`,
            tag: "a".repeat(40),
            timestamp: `2026-08-26T00:00:0${versionRequests}.000Z`,
          },
        }, { headers: { "Cache-Control": NO_STORE, "X-Deployment-Environment": "production" } });
      },
    }),
    /스모크 실행 중 배포 version이 변경/u,
  );
  assert.equal(versionRequests, 2);
});

test("extractReferencedAssets keeps bounded same-origin scripts and styles only", () => {
  assert.deepEqual(extractReferencedAssets(`
    <link href="/_next/static/app.css?x=1&amp;y=2" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.example/external.css">
    <link rel="modulepreload" href="/_next/static/lazy.js#ignored-fragment">
    <script defer src='/_next/static/app.js'></script>
  `, "https://deployment.example/"), [
    {
      path: "/_next/static/app.css?x=1&y=2",
      url: "https://deployment.example/_next/static/app.css?x=1&y=2",
      mediaType: "css",
    },
    {
      path: "/_next/static/lazy.js",
      url: "https://deployment.example/_next/static/lazy.js",
      mediaType: "javascript",
    },
    {
      path: "/_next/static/app.js",
      url: "https://deployment.example/_next/static/app.js",
      mediaType: "javascript",
    },
  ]);
});

test("recursive asset extractors follow JavaScript, CSS, manifest, and service-worker references", () => {
  assert.deepEqual(
    extractJavaScriptReferencedAssets(`
      import "./static.js";
      export { value } from "./exported.js";
      const lazy = import(\`./lazy.js\`);
    `, "https://deployment.example/_next/static/chunks/app.js").map((asset) => asset.path),
    [
      "/_next/static/chunks/static.js",
      "/_next/static/chunks/exported.js",
      "/_next/static/chunks/lazy.js",
    ],
  );
  assert.deepEqual(
    extractCssReferencedAssets(`
      @import "./theme.css";
      .logo { background: url("/icons/logo.png"); }
      @font-face { src: url(../fonts/app.woff2); }
    `, "https://deployment.example/_next/static/css/app.css").map((asset) => asset.path),
    [
      "/_next/static/css/theme.css",
      "/icons/logo.png",
      "/_next/static/fonts/app.woff2",
    ],
  );
  assert.deepEqual(
    extractManifestReferencedAssets(JSON.stringify({
      icons: [{ src: "/icons/app.png" }],
      shortcuts: [{ icons: [{ src: "/icons/shortcut.png" }] }],
    }), "https://deployment.example/manifest.webmanifest").map((asset) => asset.path),
    ["/icons/app.png", "/icons/shortcut.png"],
  );
  assert.deepEqual(
    extractServiceWorkerReferencedAssets(`
      const APP_SHELL = ["/", "/offline/", "/icons/offline.png"];
      importScripts("./worker-helper.js");
    `, "https://deployment.example/sw.js").map((asset) => asset.path),
    ["/", "/offline/", "/icons/offline.png", "/worker-helper.js"],
  );
});

test("JavaScript extraction ignores import-like strings and property calls in minified bundles", () => {
  assert.deepEqual(
    extractJavaScriptReferencedAssets(`
      const fromField = params.getAll(\`from\`) || params.getAll(\`basis\`);
      const quoted = "import('./not-a-module.js')";
      loader.import(runtimeExpression);
      import "./actual-module.js";
    `, "https://deployment.example/_next/static/chunks/app.js").map((asset) => asset.path),
    ["/_next/static/chunks/actual-module.js"],
  );
});

test("JavaScript extraction rejects a real non-literal dynamic import", () => {
  assert.throws(
    () => extractJavaScriptReferencedAssets(
      "const modulePath = './runtime.js'; import(modulePath);",
      "https://deployment.example/_next/static/chunks/app.js",
    ),
    /정적으로 해석할 수 없는 dynamic import/u,
  );
});

for (const scenario of [
  {
    name: "dynamic JavaScript import",
    sourcePath: "/_next/static/app.js",
    missingPath: "/_next/static/missing-lazy.js",
    body: 'import("./missing-lazy.js");',
  },
  {
    name: "CSS url",
    sourcePath: "/_next/static/app.css",
    missingPath: "/missing-background.png",
    body: '.hero { background-image: url("/missing-background.png"); }',
  },
  {
    name: "manifest icon",
    sourcePath: "/manifest.webmanifest",
    missingPath: "/missing-manifest-icon.png",
    body: '{"icons":[{"src":"/missing-manifest-icon.png"}]}',
  },
  {
    name: "service-worker app shell",
    sourcePath: "/sw.js",
    missingPath: "/missing-app-shell.png",
    body: 'const APP_SHELL = ["/", "/missing-app-shell.png"];',
  },
]) {
  test(`deployment smoke rejects a missing ${scenario.name} asset`, async () => {
    await assert.rejects(
      runDeploymentSmoke({
        baseUrl: "https://deployment.example",
        timeoutMs: 100,
        log() {},
        async fetcher(input) {
          const url = new URL(input);
          if (url.pathname === scenario.missingPath) {
            return new Response("missing", {
              status: 404,
              headers: { "Content-Type": "text/plain", "Cache-Control": NO_STORE },
            });
          }
          const response = responseFor(url);
          if (url.pathname !== scenario.sourcePath) return response;
          return new Response(scenario.body, { status: response.status, headers: response.headers });
        },
      }),
      new RegExp(`${scenario.missingPath.replaceAll("/", "\\/")}.*예상 상태 200, 실제 상태 404`, "u"),
    );
  });
}

test("referenced asset validation rejects wrong media, missing nosniff, and weak fingerprint caches", () => {
  const asset = { path: "/_next/static/app.js", url: "https://deployment.example/_next/static/app.js", mediaType: "javascript" };
  assert.throws(
    () => validateReferencedAssetResponse(asset, new Response("body{}", {
      headers: {
        "Content-Type": "text/css",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    })),
    /javascript Content-Type/u,
  );
  assert.throws(
    () => validateReferencedAssetResponse(asset, new Response("export{}", {
      headers: {
        "Content-Type": "text/javascript",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    })),
    /nosniff/u,
  );
  assert.throws(
    () => validateReferencedAssetResponse(asset, new Response("export{}", {
      headers: {
        "Content-Type": "text/javascript",
        "Cache-Control": "public, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    })),
    /max-age=31536000/u,
  );
});

test("referenced asset extraction rejects more than 128 same-origin assets", () => {
  const html = Array.from(
    { length: 129 },
    (_, index) => `<script src="/_next/static/chunk-${index}.js"></script>`,
  ).join("");
  assert.throws(
    () => extractReferencedAssets(html, "https://deployment.example/"),
    /128개를 초과/u,
  );
});
