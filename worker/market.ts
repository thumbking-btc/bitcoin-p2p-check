import type { WorkerExecutionContext } from "./index.ts";
import { cancelBody, readBoundedJson } from "./http-body.ts";
import { handleLightningAddressRequest } from "./lightning-address.ts";
import { handleLightningPayRequest } from "./lightning-pay.ts";
import type { LightningRequestEnvironment } from "./lightning-rate-limit.ts";
import {
  parseFeePayload,
  parsePremiumPayload,
  parsePricePayload,
  type FeeRates,
  type FeeValue,
  type PremiumValue,
  type PriceValue,
  type SourceResult,
  type UpstreamFailure,
} from "./market-source-parsers.ts";

const UPBIT_TICKER = "https://api.upbit.com/v1/ticker?markets=KRW-BTC";
const UPBIT_PREMIUM = "https://datalab-api.upbit.com/api/v1/indicator/premium/assets?symbols=BTC";
const MEMPOOL_FEES = "https://mempool.space/api/v1/fees/recommended";

const PRICE_TIMEOUT_MS = 4_000;
const PREMIUM_TIMEOUT_MS = 2_500;
const FEE_TIMEOUT_MS = 2_500;
const FRESH_CACHE_SECONDS = 15;
const PREMIUM_FRESH_CACHE_SECONDS = 5 * 60;
const PREMIUM_RETRY_BACKOFF_SECONDS = 30;
const FEE_FRESH_CACHE_SECONDS = 5 * 60;
const FEE_RETRY_BACKOFF_SECONDS = 30;
const STALE_CACHE_SECONDS = 5 * 60;
const MAX_UPSTREAM_JSON_BYTES = 256_000;
const MAX_CACHED_JSON_BYTES = 256_000;

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

type PremiumBackoff = {
  failure: UpstreamFailure;
};

type FeeBackoff = {
  failure: UpstreamFailure;
};

type ResolvedSource<T> = {
  value: T | null;
  state: SourceState;
  failure: UpstreamFailure | null;
  staleAgeSeconds: number | null;
};

type MarketSnapshot = {
  checkedAt: string;
  servedAt: string;
  status: "current" | "partial" | "stale" | "unavailable";
  priceKrw: number | null;
  priceObservedAt: string | null;
  koreaPremium: number | null;
  premiumCheckedAt: string | null;
  feeRates: FeeRates | null;
  feeCheckedAt: string | null;
  sourceStatus: {
    price: SourceState;
    premium: SourceState;
    fees: SourceState;
  };
  sourceFailure: {
    price: UpstreamFailure | null;
    premium: UpstreamFailure | null;
    fees: UpstreamFailure | null;
  };
  staleAgeSeconds: {
    price: number | null;
    premium: number | null;
    fees: number | null;
  };
  sources: {
    price: string;
    premium: string;
    fees: string;
  };
};

type CloudflareCacheStorage = CacheStorage & { default: Cache };

async function fetchJson(url: string, timeoutMs: number): Promise<SourceResult<unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: REQUEST_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) {
      await cancelBody(response.body);
      return { ok: false, failure: "http" };
    }
    return {
      ok: true,
      value: await readBoundedJson(response, MAX_UPSTREAM_JSON_BYTES, controller.signal),
    };
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { ok: false, failure: "timeout" };
    }
    if (error instanceof TypeError) {
      console.error(JSON.stringify({ event: "market_upstream_request_failed", errorName: error.name }));
      return { ok: false, failure: "network" };
    }
    return { ok: false, failure: "invalid" };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPrice(nowMs: number, retrievedAt: string): Promise<SourceResult<PriceValue>> {
  const result = await fetchJson(UPBIT_TICKER, PRICE_TIMEOUT_MS);
  if (!result.ok) return result;
  return parsePricePayload(result.value, nowMs, retrievedAt);
}

async function fetchPremium(retrievedAt: string): Promise<SourceResult<PremiumValue>> {
  const result = await fetchJson(UPBIT_PREMIUM, PREMIUM_TIMEOUT_MS);
  if (!result.ok) return result;
  return parsePremiumPayload(result.value, retrievedAt);
}

async function fetchFees(retrievedAt: string): Promise<SourceResult<FeeValue>> {
  const result = await fetchJson(MEMPOOL_FEES, FEE_TIMEOUT_MS);
  if (!result.ok) return result;
  return parseFeePayload(result.value, retrievedAt);
}

type CacheName =
  | "fresh-with-price"
  | "fresh-reference"
  | "last-price"
  | "fresh-premium"
  | "last-premium"
  | "premium-backoff"
  | "fresh-fees"
  | "last-fees"
  | "fees-backoff";

function cacheKey(request: Request, name: CacheName): Request {
  const url = new URL(request.url);
  url.pathname = "/api/market";
  url.search = `?internal-cache=${name}`;
  return new Request(url.toString(), { method: "GET" });
}

async function readCachedJson<T>(cache: Cache, key: Request): Promise<T | null> {
  const response = await cache.match(key);
  if (!response) return null;
  try {
    return await readBoundedJson(response, MAX_CACHED_JSON_BYTES) as T;
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

async function resolvePremium(
  request: Request,
  cache: Cache,
  context: WorkerExecutionContext,
  nowMs: number,
  retrievedAt: string,
): Promise<ResolvedSource<PremiumValue>> {
  const [freshPremium, lastPremium, backoff] = await Promise.all([
    readCachedJson<PremiumValue>(cache, cacheKey(request, "fresh-premium")),
    readCachedJson<PremiumValue>(cache, cacheKey(request, "last-premium")),
    readCachedJson<PremiumBackoff>(cache, cacheKey(request, "premium-backoff")),
  ]);

  if (freshPremium) {
    return { value: freshPremium, state: "current", failure: null, staleAgeSeconds: null };
  }

  const usableLastPremium = lastPremium && isRecent(lastPremium.retrievedAt, nowMs)
    ? lastPremium
    : null;
  if (backoff) {
    return {
      value: usableLastPremium,
      state: usableLastPremium ? "stale" : "unavailable",
      failure: backoff.failure,
      staleAgeSeconds: usableLastPremium ? ageSeconds(usableLastPremium.retrievedAt, nowMs) : null,
    };
  }

  const result = await fetchPremium(retrievedAt);
  if (result.ok) {
    context.waitUntil(Promise.all([
      cache.put(
        cacheKey(request, "fresh-premium"),
        cacheResponse(result.value, PREMIUM_FRESH_CACHE_SECONDS),
      ),
      cache.put(
        cacheKey(request, "last-premium"),
        cacheResponse(result.value, STALE_CACHE_SECONDS),
      ),
    ]).then(() => undefined));
    return { value: result.value, state: "current", failure: null, staleAgeSeconds: null };
  }

  context.waitUntil(cache.put(
    cacheKey(request, "premium-backoff"),
    cacheResponse({ failure: result.failure }, PREMIUM_RETRY_BACKOFF_SECONDS),
  ));
  return {
    value: usableLastPremium,
    state: usableLastPremium ? "stale" : "unavailable",
    failure: result.failure,
    staleAgeSeconds: usableLastPremium ? ageSeconds(usableLastPremium.retrievedAt, nowMs) : null,
  };
}

async function resolveFees(
  request: Request,
  cache: Cache,
  context: WorkerExecutionContext,
  nowMs: number,
  retrievedAt: string,
): Promise<ResolvedSource<FeeValue>> {
  const [freshFees, lastFees, backoff] = await Promise.all([
    readCachedJson<FeeValue>(cache, cacheKey(request, "fresh-fees")),
    readCachedJson<FeeValue>(cache, cacheKey(request, "last-fees")),
    readCachedJson<FeeBackoff>(cache, cacheKey(request, "fees-backoff")),
  ]);

  if (freshFees) {
    return { value: freshFees, state: "current", failure: null, staleAgeSeconds: null };
  }

  const usableLastFees = lastFees && isRecent(lastFees.retrievedAt, nowMs) ? lastFees : null;
  if (backoff) {
    return {
      value: usableLastFees,
      state: usableLastFees ? "stale" : "unavailable",
      failure: backoff.failure,
      staleAgeSeconds: usableLastFees ? ageSeconds(usableLastFees.retrievedAt, nowMs) : null,
    };
  }

  const result = await fetchFees(retrievedAt);
  if (result.ok) {
    context.waitUntil(Promise.all([
      cache.put(
        cacheKey(request, "fresh-fees"),
        cacheResponse(result.value, FEE_FRESH_CACHE_SECONDS),
      ),
      cache.put(
        cacheKey(request, "last-fees"),
        cacheResponse(result.value, STALE_CACHE_SECONDS),
      ),
    ]).then(() => undefined));
    return { value: result.value, state: "current", failure: null, staleAgeSeconds: null };
  }

  context.waitUntil(cache.put(
    cacheKey(request, "fees-backoff"),
    cacheResponse({ failure: result.failure }, FEE_RETRY_BACKOFF_SECONDS),
  ));
  return {
    value: usableLastFees,
    state: usableLastFees ? "stale" : "unavailable",
    failure: result.failure,
    staleAgeSeconds: usableLastFees ? ageSeconds(usableLastFees.retrievedAt, nowMs) : null,
  };
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
  includePrice: boolean,
): Promise<MarketSnapshot> {
  const now = new Date();
  const nowMs = now.getTime();
  const checkedAt = now.toISOString();

  const [priceResult, premiumResult, feeResult, cachedPrice] = await Promise.all([
    includePrice ? fetchPrice(nowMs, checkedAt) : Promise.resolve(null),
    resolvePremium(request, cache, context, nowMs, checkedAt),
    resolveFees(request, cache, context, nowMs, checkedAt),
    includePrice ? readCachedJson<PriceValue>(cache, cacheKey(request, "last-price")) : Promise.resolve(null),
  ]);

  const usableCachedPrice = cachedPrice && isRecent(cachedPrice.retrievedAt, nowMs)
    ? cachedPrice
    : null;
  const price = priceResult?.ok ? priceResult.value : usableCachedPrice;
  const premium = premiumResult.value;
  const priceState: SourceState = !includePrice
    ? "unavailable"
    : priceResult?.ok
      ? "current"
      : price
        ? "stale"
        : "unavailable";
  const premiumState = premiumResult.state;

  if (priceResult?.ok) {
    context.waitUntil(cache.put(
      cacheKey(request, "last-price"),
      cacheResponse(priceResult.value, STALE_CACHE_SECONDS),
    ));
  }

  const status: MarketSnapshot["status"] = includePrice
    ? priceState === "unavailable"
      ? "unavailable"
      : priceState === "stale"
        ? "stale"
        : premiumState === "current"
          ? "current"
          : "partial"
    : premiumState === "stale"
      ? "stale"
      : "partial";

  return {
    checkedAt,
    servedAt: checkedAt,
    status,
    priceKrw: price?.priceKrw ?? null,
    priceObservedAt: price?.priceObservedAt ?? null,
    koreaPremium: premium?.koreaPremium ?? null,
    premiumCheckedAt: premium?.retrievedAt ?? null,
    feeRates: feeResult.value?.feeRates ?? null,
    feeCheckedAt: feeResult.value?.retrievedAt ?? null,
    sourceStatus: { price: priceState, premium: premiumState, fees: feeResult.state },
    sourceFailure: {
      price: includePrice && priceResult && !priceResult.ok ? priceResult.failure : null,
      premium: premiumResult.failure,
      fees: feeResult.failure,
    },
    staleAgeSeconds: {
      price: priceState === "stale" ? ageSeconds(price?.retrievedAt ?? null, nowMs) : null,
      premium: premiumResult.staleAgeSeconds,
      fees: feeResult.staleAgeSeconds,
    },
    sources: {
      price: "https://global-docs.upbit.com/docs/upbit-quotation-restful-api",
      premium: "https://datalab.upbit.com/assets/BTC/upbit-premium",
      fees: "https://mempool.space/api/v1/fees/recommended",
    },
  };
}

export async function handleMarketRequest(
  request: Request,
  context: WorkerExecutionContext,
  environment?: LightningRequestEnvironment,
): Promise<Response> {
  const receiveMode = new URL(request.url).searchParams.get("receive");
  if (request.method === "POST" && receiveMode === "lightning-address") {
    return handleLightningAddressRequest(request, environment);
  }
  if (request.method === "POST" && receiveMode === "lightning-pay") {
    return handleLightningPayRequest(request, environment);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    const headers = new Headers(API_HEADERS);
    headers.set("Allow", "GET, HEAD");
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers,
    });
  }

  const includePrice = new URL(request.url).searchParams.get("price") !== "0";
  const cache = (caches as CloudflareCacheStorage).default;
  const freshKey = cacheKey(request, includePrice ? "fresh-with-price" : "fresh-reference");
  const cached = await readCachedJson<MarketSnapshot>(cache, freshKey);
  if (cached) return publicResponse(cached, "HIT", request.method);

  const snapshot = await buildSnapshot(request, cache, context, includePrice);
  if (snapshot.status !== "unavailable") {
    context.waitUntil(cache.put(
      freshKey,
      cacheResponse(snapshot, FRESH_CACHE_SECONDS),
    ));
  }

  return publicResponse(snapshot, "MISS", request.method);
}
