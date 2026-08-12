import type { WorkerExecutionContext } from "./index";

const UPBIT_TICKER = "https://api.upbit.com/v1/ticker?markets=KRW-BTC";
const UPBIT_PREMIUM = "https://datalab-api.upbit.com/api/v1/indicator/premium/assets?symbols=BTC";

const PRICE_TIMEOUT_MS = 4_000;
const PREMIUM_TIMEOUT_MS = 2_500;
const FRESH_CACHE_SECONDS = 15;
const STALE_CACHE_SECONDS = 5 * 60;
const MAX_PRICE_OBSERVATION_AGE_MS = 2 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;

const REQUEST_HEADERS = {
  Accept: "application/json",
  "User-Agent": "BitcoinP2PCheck/1.0 (+price reference calculator)",
};

const API_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

type SourceState = "current" | "stale" | "unavailable";
type UpstreamFailure = "timeout" | "http" | "network" | "invalid";

type PriceValue = {
  priceKrw: number;
  priceObservedAt: string;
  retrievedAt: string;
};

type PremiumValue = {
  koreaPremium: number;
  retrievedAt: string;
};

type SourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: UpstreamFailure };

type MarketSnapshot = {
  checkedAt: string;
  servedAt: string;
  status: "current" | "partial" | "stale" | "unavailable";
  priceKrw: number | null;
  priceObservedAt: string | null;
  koreaPremium: number | null;
  premiumCheckedAt: string | null;
  sourceStatus: {
    price: SourceState;
    premium: SourceState;
  };
  sourceFailure: {
    price: UpstreamFailure | null;
    premium: UpstreamFailure | null;
  };
  staleAgeSeconds: {
    price: number | null;
    premium: number | null;
  };
  sources: {
    price: string;
    premium: string;
  };
};

type CloudflareCacheStorage = CacheStorage & { default: Cache };

let pendingSnapshot: Promise<MarketSnapshot> | null = null;

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value: number): string | null {
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<SourceResult<unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: REQUEST_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, failure: "http" };
    return { ok: true, value: await response.json() };
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { ok: false, failure: "timeout" };
    }
    return { ok: false, failure: "network" };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPrice(nowMs: number, retrievedAt: string): Promise<SourceResult<PriceValue>> {
  const result = await fetchJson(UPBIT_TICKER, PRICE_TIMEOUT_MS);
  if (!result.ok) return result;

  const ticker = Array.isArray(result.value) ? result.value[0] : null;
  const priceKrw = finite(ticker?.trade_price);
  const tradeTimestamp = finite(ticker?.trade_timestamp);
  const priceObservedAt = tradeTimestamp === null ? null : isoTimestamp(tradeTimestamp);

  if (priceKrw === null || priceKrw <= 0 || tradeTimestamp === null || priceObservedAt === null) {
    return { ok: false, failure: "invalid" };
  }

  const observationAge = nowMs - tradeTimestamp;
  if (observationAge > MAX_PRICE_OBSERVATION_AGE_MS || observationAge < -MAX_FUTURE_CLOCK_SKEW_MS) {
    return { ok: false, failure: "invalid" };
  }

  return {
    ok: true,
    value: { priceKrw, priceObservedAt, retrievedAt },
  };
}

async function fetchPremium(retrievedAt: string): Promise<SourceResult<PremiumValue>> {
  const result = await fetchJson(UPBIT_PREMIUM, PREMIUM_TIMEOUT_MS);
  if (!result.ok) return result;

  const data = result.value as {
    data?: { records?: Array<{ code?: unknown; pair?: unknown; disparityRate?: unknown }> };
  } | null;
  const records = Array.isArray(data?.data?.records) ? data.data.records : [];
  const btcPremium = records.find((record) =>
    record?.code === "CRIX.UPBIT.KRW-BTC" || record?.pair === "BTC/KRW");
  const premiumPercent = finite(btcPremium?.disparityRate);
  const koreaPremium = premiumPercent === null ? null : premiumPercent / 100;

  if (koreaPremium === null || Math.abs(koreaPremium) > 0.5) {
    return { ok: false, failure: "invalid" };
  }

  return { ok: true, value: { koreaPremium, retrievedAt } };
}

function cacheKey(request: Request, name: "fresh" | "last-price" | "last-premium"): Request {
  const url = new URL(request.url);
  url.pathname = "/api/market";
  url.search = `?internal-cache=${name}`;
  return new Request(url.toString(), { method: "GET" });
}

async function readCachedJson<T>(cache: Cache, key: Request): Promise<T | null> {
  const response = await cache.match(key);
  if (!response) return null;
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

function cacheResponse(value: unknown, maxAgeSeconds: number): Response {
  return Response.json(value, {
    headers: {
      "Cache-Control": `public, max-age=${maxAgeSeconds}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function ageSeconds(timestamp: string | null, nowMs: number): number | null {
  if (!timestamp) return null;
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor((nowMs - value) / 1_000));
}

function isRecent(timestamp: string | null, nowMs: number): boolean {
  const age = ageSeconds(timestamp, nowMs);
  return age !== null && age <= STALE_CACHE_SECONDS;
}

function publicResponse(snapshot: MarketSnapshot, cacheState: "HIT" | "MISS", method: string): Response {
  const status = snapshot.status === "unavailable" ? 503 : 200;
  const headers = new Headers(API_HEADERS);
  headers.set("X-Market-Cache", cacheState);
  const body = method === "HEAD" ? null : JSON.stringify({
    ...snapshot,
    servedAt: new Date().toISOString(),
  });
  return new Response(body, { status, headers });
}

async function buildSnapshot(
  request: Request,
  cache: Cache,
  context: WorkerExecutionContext,
): Promise<MarketSnapshot> {
  const now = new Date();
  const nowMs = now.getTime();
  const checkedAt = now.toISOString();
  const [priceResult, premiumResult, cachedPrice, cachedPremium] = await Promise.all([
    fetchPrice(nowMs, checkedAt),
    fetchPremium(checkedAt),
    readCachedJson<PriceValue>(cache, cacheKey(request, "last-price")),
    readCachedJson<PremiumValue>(cache, cacheKey(request, "last-premium")),
  ]);

  const usableCachedPrice = cachedPrice && isRecent(cachedPrice.retrievedAt, nowMs)
    ? cachedPrice
    : null;
  const usableCachedPremium = cachedPremium && isRecent(cachedPremium.retrievedAt, nowMs)
    ? cachedPremium
    : null;
  const price = priceResult.ok ? priceResult.value : usableCachedPrice;
  const premium = premiumResult.ok ? premiumResult.value : usableCachedPremium;
  const priceState: SourceState = priceResult.ok ? "current" : price ? "stale" : "unavailable";
  const premiumState: SourceState = premiumResult.ok ? "current" : premium ? "stale" : "unavailable";

  if (priceResult.ok) {
    context.waitUntil(cache.put(
      cacheKey(request, "last-price"),
      cacheResponse(priceResult.value, STALE_CACHE_SECONDS),
    ));
  }
  if (premiumResult.ok) {
    context.waitUntil(cache.put(
      cacheKey(request, "last-premium"),
      cacheResponse(premiumResult.value, STALE_CACHE_SECONDS),
    ));
  }

  const status: MarketSnapshot["status"] = priceState === "unavailable"
    ? "unavailable"
    : priceState === "stale"
      ? "stale"
      : premiumState === "current"
        ? "current"
        : "partial";

  return {
    checkedAt,
    servedAt: checkedAt,
    status,
    priceKrw: price?.priceKrw ?? null,
    priceObservedAt: price?.priceObservedAt ?? null,
    koreaPremium: premium?.koreaPremium ?? null,
    premiumCheckedAt: premium?.retrievedAt ?? null,
    sourceStatus: { price: priceState, premium: premiumState },
    sourceFailure: {
      price: priceResult.ok ? null : priceResult.failure,
      premium: premiumResult.ok ? null : premiumResult.failure,
    },
    staleAgeSeconds: {
      price: priceState === "stale" ? ageSeconds(price?.retrievedAt ?? null, nowMs) : null,
      premium: premiumState === "stale" ? ageSeconds(premium?.retrievedAt ?? null, nowMs) : null,
    },
    sources: {
      price: "https://global-docs.upbit.com/docs/upbit-quotation-restful-api",
      premium: "https://datalab.upbit.com/assets/BTC/upbit-premium",
    },
  };
}

export async function handleMarketRequest(
  request: Request,
  context: WorkerExecutionContext,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const headers = new Headers(API_HEADERS);
    headers.set("Allow", "GET, HEAD");
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers,
    });
  }

  const cache = (caches as CloudflareCacheStorage).default;
  const freshKey = cacheKey(request, "fresh");
  const cached = await readCachedJson<MarketSnapshot>(cache, freshKey);
  if (cached) return publicResponse(cached, "HIT", request.method);

  if (!pendingSnapshot) {
    pendingSnapshot = buildSnapshot(request, cache, context).finally(() => {
      pendingSnapshot = null;
    });
  }

  const snapshot = await pendingSnapshot;
  if (snapshot.status !== "unavailable") {
    context.waitUntil(cache.put(
      freshKey,
      cacheResponse(snapshot, FRESH_CACHE_SECONDS),
    ));
  }

  return publicResponse(snapshot, "MISS", request.method);
}
