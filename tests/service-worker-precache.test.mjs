import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const origin = "https://precache.example";

function installWorker({ failSharedAsset = false } = {}) {
  const handlers = new Map();
  const entries = new Map();
  const fetchCounts = new Map();
  const deletedCaches = [];
  const cacheKey = (request) => new URL(typeof request === "string" ? request : request.url, origin).href;
  const cache = {
    match: async (request) => entries.get(cacheKey(request)),
    put: async (request, response) => entries.set(cacheKey(request), response),
  };
  const htmlPaths = new Set(["/", "/install/", "/privacy/", "/verify/", "/404"]);
  vm.runInNewContext(source, {
    URL, Response,
    self: {
      location: { href: `${origin}/sw.js?v=test`, origin },
      addEventListener: (type, handler) => handlers.set(type, handler),
    },
    caches: {
      open: async () => cache,
      delete: async (name) => { deletedCaches.push(name); entries.clear(); return true; },
    },
    fetch: async (request) => {
      const pathname = new URL(request, origin).pathname;
      fetchCounts.set(pathname, (fetchCounts.get(pathname) ?? 0) + 1);
      // Keep shared fetches pending until every shell has parsed its references.
      if (pathname === "/shared.js") await new Promise((resolve) => setImmediate(resolve));
      if (pathname === "/shared.js" && failSharedAsset) return new Response("failed", { status: 503 });
      return htmlPaths.has(pathname)
        ? new Response('<script src="/shared.js"></script><link href="/shared.css" rel="stylesheet">', {
          headers: { "content-type": "text/html" },
        })
        : new Response("asset");
    },
  });
  let completion;
  handlers.get("install")({ waitUntil: (promise) => { completion = promise; } });
  return { completion, entries, fetchCounts, deletedCaches };
}

test("parallel app shells fetch and cache each shared asset once", async () => {
  const run = installWorker();
  await run.completion;
  assert.equal(run.fetchCounts.get("/shared.js"), 1);
  assert.equal(run.fetchCounts.get("/shared.css"), 1);
  assert.ok(run.entries.has(`${origin}/shared.js`));
  assert.ok(run.entries.has(`${origin}/shared.css`));
  assert.deepEqual(run.deletedCaches, []);
});

test("a failed shared asset rejects installation and removes the incomplete cache", async () => {
  const run = installWorker({ failSharedAsset: true });
  await assert.rejects(run.completion, /필수 앱 자산을 가져오지 못했습니다/);
  assert.equal(run.fetchCounts.get("/shared.js"), 1);
  assert.equal(run.deletedCaches.length, 1);
  assert.match(run.deletedCaches[0], /^bitcoin-p2p-check-precache-/);
  assert.equal(run.entries.size, 0);
});
