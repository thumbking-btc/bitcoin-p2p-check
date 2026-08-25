const workerUrl = new URL(self.location.href);
const WORKER_VERSION = workerUrl.searchParams.get("v") || "dev";
const PRECACHE_NAME = `bitcoin-p2p-check-precache-${WORKER_VERSION}`;
const RUNTIME_CACHE_NAME = `bitcoin-p2p-check-runtime-${WORKER_VERSION}`;
const CACHE_PREFIX = "bitcoin-p2p-check-";
const MAX_RUNTIME_ENTRIES = 40;
const APP_SHELL = [
  "/",
  "/install/",
  "/privacy/",
  "/verify/",
  "/404",
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
  if (!response.ok) throw new Error(`필수 앱 셸을 가져오지 못했습니다: ${path}`);

  await cache.put(path, response.clone());
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return;

  const html = await response.text();
  const assets = referencedSameOriginAssets(html, new URL(path, self.location.origin));
  await Promise.all(assets.map(async (assetUrl) => {
    if (await cache.match(assetUrl)) return;
    const assetResponse = await fetch(assetUrl, { cache: "reload" });
    if (!assetResponse.ok) throw new Error(`필수 앱 자산을 가져오지 못했습니다: ${assetUrl}`);
    await cache.put(assetUrl, assetResponse);
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

  const pathname = new URL(request.url).pathname;
  const fallbackPath = pathname === "/"
    ? "/"
    : pathname === "/install" || pathname.startsWith("/install/")
      ? "/install/"
      : pathname === "/privacy" || pathname.startsWith("/privacy/")
        ? "/privacy/"
        : pathname === "/verify" || pathname.startsWith("/verify/")
          ? "/verify/"
          : "/404";
  const [runtime, precache] = await Promise.all([
    caches.open(RUNTIME_CACHE_NAME),
    caches.open(PRECACHE_NAME),
  ]);
  const fallback = (await runtime.match(fallbackPath)) ?? (await precache.match(fallbackPath));
  if (!fallback) return Response.error();
  if (fallbackPath !== "/404") return fallback;
  return new Response(fallback.body, {
    status: 404,
    statusText: "Not Found",
    headers: fallback.headers,
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE_NAME);
    try {
      await Promise.all(APP_SHELL.map((path) => precachePath(cache, path)));
    } catch (error) {
      await caches.delete(PRECACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }
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
          // Verification URLs contain bearer record IDs. Keep only the generic
          // shell in the precache and never persist the full query as a cache key.
          if (response.ok && url.pathname !== "/verify" && !url.pathname.startsWith("/verify/")) {
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
