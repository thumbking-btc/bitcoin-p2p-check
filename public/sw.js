const CACHE_PREFIX = "bitcoin-p2p-check-";
const CACHE_NAME = "bitcoin-p2p-check-v5";
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

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(async (path) => {
      const response = await fetch(path, { cache: "reload" });
      if (!response.ok) throw new Error(`app shell request failed: ${path}`);
      await cache.put(path, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
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
    const cachePromise = caches.open(CACHE_NAME);
    // Never persist personalized or otherwise user-controlled query strings.
    if (url.search) {
      event.respondWith(
        fetch(request, { cache: "no-store" })
          .catch(async () => {
            const cache = await cachePromise;
            return (await cache.match(url.pathname)) ?? cache.match("/");
          }),
      );
      return;
    }
    const network = fetch(request);
    event.waitUntil(network.then(async (response) => {
      if (response.ok) await (await cachePromise).put(request, response.clone());
    }).catch(() => {}));
    event.respondWith(
      network.catch(async () => {
        const cache = await cachePromise;
        return (await cache.match(request)) ?? cache.match("/");
      }),
    );
    return;
  }

  if (["script", "style", "image", "font"].includes(request.destination)) {
    const cachePromise = caches.open(CACHE_NAME);
    const network = fetch(request);
    event.waitUntil(network.then(async (response) => {
      if (response.ok) await (await cachePromise).put(request, response.clone());
    }).catch(() => {}));
    event.respondWith(
      cachePromise.then((cache) => cache.match(request)).then((cached) => cached ?? network),
    );
  }
});
