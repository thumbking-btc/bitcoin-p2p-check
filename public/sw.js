const workerUrl = new URL(self.location.href);
const WORKER_VERSION = workerUrl.searchParams.get("v") || "dev";
const PRECACHE_NAME = `bitcoin-p2p-check-precache-${WORKER_VERSION}`;
const RUNTIME_CACHE_NAME = `bitcoin-p2p-check-runtime-${WORKER_VERSION}`;
const CACHE_PREFIX = "bitcoin-p2p-check-";
const MAX_RUNTIME_ENTRIES = 40;
const APP_SHELL = [
  "/",
  "/install/",
  "/manifest.webmanifest",
  "/favicon-v2.svg",
  "/icons/icon-192-v2.png",
  "/icons/icon-512-v2.png",
  "/icons/icon-maskable-512-v2.png",
  "/icons/apple-touch-icon-v2.png",
];
const APP_SHELL_PATHS = new Set(APP_SHELL);

async function putRuntime(request, response) {
  const cache = await caches.open(RUNTIME_CACHE_NAME);
  await cache.put(request, response);

  const keys = await cache.keys();
  const overflow = keys.length - MAX_RUNTIME_ENTRIES;
  if (overflow > 0) {
    await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
  }
}

function referencedSameOriginAssets(html, baseUrl) {
  const assets = new Set();
  const attributePattern = /(?:src|href)=["']([^"'#]+)["']/g;
  let match;
  while ((match = attributePattern.exec(html)) !== null) {
    try {
      const url = new URL(match[1], baseUrl);
      if (url.origin !== self.location.origin) continue;
      if (url.pathname.startsWith("/api/") || APP_SHELL_PATHS.has(url.pathname)) continue;
      assets.add(url.toString());
    } catch {
      // 잘못된 URL 하나 때문에 나머지 앱 셸 캐시를 포기하지 않습니다.
    }
  }
  return [...assets];
}

async function precachePath(cache, path) {
  const response = await fetch(path, { cache: "reload" });
  if (!response.ok) return;

  await cache.put(path, response.clone());
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return;

  const html = await response.text();
  const assets = referencedSameOriginAssets(html, new URL(path, self.location.origin));
  await Promise.allSettled(assets.map(async (assetUrl) => {
    if (await cache.match(assetUrl)) return;
    const assetResponse = await fetch(assetUrl, { cache: "reload" });
    if (assetResponse.ok) await cache.put(assetUrl, assetResponse);
  }));
}

async function matchCurrentCaches(request) {
  const [runtime, precache] = await Promise.all([
    caches.open(RUNTIME_CACHE_NAME),
    caches.open(PRECACHE_NAME),
  ]);
  return (await runtime.match(request)) ?? (await precache.match(request)) ?? null;
}

async function matchOfflineNavigation(request) {
  const exact = await matchCurrentCaches(request);
  if (exact) return exact;

  const [runtime, precache] = await Promise.all([
    caches.open(RUNTIME_CACHE_NAME),
    caches.open(PRECACHE_NAME),
  ]);
  return (await runtime.match("/")) ?? (await precache.match("/")) ?? Response.error();
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE_NAME);
    await Promise.allSettled(APP_SHELL.map((path) => precachePath(cache, path)));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  const activeCaches = new Set([PRECACHE_NAME, RUNTIME_CACHE_NAME]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && !activeCaches.has(key))
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 현재가와 프리미엄은 오프라인 값으로 대체하지 않습니다.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            event.waitUntil(putRuntime(request, response.clone()).catch(() => {}));
          }
          return response;
        })
        .catch(() => matchOfflineNavigation(request)),
    );
    return;
  }

  if (["script", "style", "image", "font"].includes(request.destination)) {
    event.respondWith((async () => {
      const cached = await matchCurrentCaches(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok) {
        event.waitUntil(putRuntime(request, response.clone()).catch(() => {}));
      }
      return response;
    })());
  }
});
