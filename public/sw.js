const PRECACHE_NAME = "bitcoin-p2p-check-precache-v6";
const RUNTIME_CACHE_NAME = "bitcoin-p2p-check-runtime-v1";
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

async function putRuntime(request, response) {
  const cache = await caches.open(RUNTIME_CACHE_NAME);
  await cache.put(request, response);

  const keys = await cache.keys();
  const overflow = keys.length - MAX_RUNTIME_ENTRIES;
  if (overflow > 0) {
    await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE_NAME);
    await Promise.allSettled(APP_SHELL.map(async (path) => {
      const response = await fetch(path, { cache: "reload" });
      if (response.ok) await cache.put(path, response);
    }));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  const activeCaches = new Set([PRECACHE_NAME, RUNTIME_CACHE_NAME]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !activeCaches.has(key)).map((key) => caches.delete(key))))
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
        .catch(async () => (await caches.match(request)) ?? caches.match("/")),
    );
    return;
  }

  if (["script", "style", "image", "font"].includes(request.destination)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok) {
        event.waitUntil(putRuntime(request, response.clone()).catch(() => {}));
      }
      return response;
    })());
  }
});
