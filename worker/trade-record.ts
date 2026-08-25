import { validateBolt11Invoice } from "../app/lib/bolt11-invoice.mjs";
import { createOnchainRequest } from "../app/lib/onchain-request.mjs";
import {
  TRADE_RECORD_PUBLIC_KEYS,
  type TradeRecordPublicJwk,
} from "../app/lib/trade-record-verification.ts";
import {
  assertFreshTradeRecordReference,
  canonicalTradeRecordBytes,
  canonicalizeTradeRecord,
  canonicalizeTradeRecordCondition,
  getTradeRecordRetentionPolicy,
  isTradeRecordId,
  TRADE_RECORD_KEY_ID_PATTERN,
  TRADE_RECORD_SCHEMA_V1,
  TradeRecordValidationError,
  type SignedTradeRecord,
  type TradeRecordPayment,
} from "../app/lib/trade-record.ts";
import { BoundedBodyError, cancelBody, readBoundedBytes, readBoundedJson } from "./http-body.ts";
import { LightningAddressNormalizationError, normalizeLightningAddress } from "./lightning-address-normalize.ts";
import { parsePremiumPayload } from "./market-source-parsers.ts";
import { fail, json, methodNotAllowed, TradeRecordRequestError } from "./trade-record-http.ts";
import {
  authorizationToken,
  assertTradeRecordPaymentFinalizable,
  base64Url,
  createRevokeToken,
  managementKey,
  MIN_LIGHTNING_PAYMENT_REMAINING_SECONDS,
  parseCreateLifecycle,
  parseManagementIndex,
  parseStoredRecord,
  PENDING_RECORD_TTL_SECONDS,
  recordsExplicitlyDisabled,
  recordTtl,
  sha256Base64Url,
  storageKey,
  storedManagedRecord,
  type ManagementIndex,
  type RecordLifecycle,
} from "./trade-record-lifecycle.ts";

const MAX_REQUEST_BYTES = 8_192;
const MAX_PRIVATE_JWK_BYTES = 2_048;
const MAX_UPBIT_RESPONSE_BYTES = 16_384;
const WRITTEN_TRADE_RECORD_SCHEMA = TRADE_RECORD_SCHEMA_V1;
const UPBIT_PRICE_URL = "https://api.upbit.com/v1/ticker?markets=KRW-BTC";
const UPBIT_PREMIUM_URL = "https://datalab-api.upbit.com/api/v1/indicator/premium/assets?symbols=BTC";
const UPBIT_PRICE_TIMEOUT_MS = 4_000;
const UPBIT_PREMIUM_TIMEOUT_MS = 2_500;
const UPBIT_PRICE_MAX_AGE_MS = 2 * 60_000;
const UPBIT_PRICE_MAX_DEVIATION_RATIO = 0.01;
const UPBIT_PREMIUM_MAX_ABSOLUTE_DEVIATION = 0.005;
const UPBIT_PRICE_MAX_REDIRECTS = 2;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;
const BASE64URL_COORDINATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_PRIVATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CF_CONNECTING_IP_PATTERN = /^[0-9A-Fa-f:.]{3,64}$/u;

export interface TradeRecordKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: Readonly<{ expirationTtl: number }>): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Durable Object adapter barrier for the best-effort legacy KV mirror.
   * Native KV bindings complete each mutation before their promise resolves and
   * therefore do not need to implement this method.
   */
  flushLegacyMirror?(): Promise<void>;
}

export interface TradeRecordRateLimit {
  limit(options: Readonly<{ key: string }>): Promise<Readonly<{ success: boolean }>>;
}

export interface TradeRecordStateNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): Readonly<{ fetch(request: Request): Promise<Response> }>;
}

export interface TradeRecordEnvironment {
  /** Non-secret deployment label. `preview` disables this API before binding access. */
  DEPLOYMENT_ENV?: string;
  TRADE_RECORDS?: TradeRecordKvNamespace;
  TRADE_RECORD_CREATE_RATE_LIMITER?: TradeRecordRateLimit;
  TRADE_RECORD_READ_RATE_LIMITER?: TradeRecordRateLimit;
  TRADE_RECORD_STATE?: TradeRecordStateNamespace;
  /** Secret: JSON-encoded private P-256 JWK with a public `kid`. */
  TRADE_RECORD_SIGNING_KEY?: string;
  /** Non-secret feature flag. Explicit false values disable this API before binding access. */
  TRADE_RECORDS_ENABLED?: string | boolean;
}

export type TradeRecordHandlerOptions = Readonly<{
  /** Test seam only. Production callers must use the committed public-key map. */
  publicKeys?: Readonly<Record<string, TradeRecordPublicJwk>>;
  /** Test seam only. Production callers use the global fetch implementation. */
  fetcher?: typeof fetch;
  /** Test seam for in-memory KV fixtures. Production must use the Durable Object binding. */
  allowLegacyKv?: boolean;
  /** Internal recursion guard used only inside TradeRecordState. */
  storageMode?: "durable-object";
}>;

type PrivateSigningJwk = JsonWebKey & {
  crv: "P-256";
  d: string;
  kid: string;
  kty: "EC";
  x: string;
  y: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function readLimitedJson(request: Request): Promise<unknown> {
  try {
    return await readBoundedJson(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BoundedBodyError && error.failure === "too-large") {
      fail("REQUEST_TOO_LARGE", "요청 내용이 너무 큽니다.", 413);
    }
    if (error instanceof BoundedBodyError && error.failure === "invalid-media-type") {
      fail("INVALID_REQUEST", "JSON 요청만 사용할 수 있습니다.", 415);
    }
    fail("INVALID_REQUEST", "요청 JSON을 확인하지 못했습니다.");
  }
}

async function readLimitedResponseJson(response: Response, maximumBytes: number): Promise<unknown> {
  try {
    return await readBoundedJson(response, maximumBytes);
  } catch (error) {
    if (error instanceof BoundedBodyError && error.failure === "too-large") {
      fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 기준가 응답이 너무 큽니다.", 503);
    }
    fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 기준가 응답 형식을 확인하지 못했습니다.", 503);
  }
}

async function enforceCreateRateLimit(request: Request, environment: TradeRecordEnvironment): Promise<void> {
  const limiter = environment.TRADE_RECORD_CREATE_RATE_LIMITER;
  const connectingIp = request.headers.get("CF-Connecting-IP") ?? "";
  if (!limiter || !CF_CONNECTING_IP_PATTERN.test(connectingIp)) {
    fail("RATE_LIMIT_UNAVAILABLE", "거래 기록 생성 요청을 안전하게 제한하지 못했습니다.", 503);
  }

  let result: Readonly<{ success: boolean }>;
  try {
    result = await limiter.limit({ key: `trade-record:create:${connectingIp.toLowerCase()}` });
  } catch {
    fail("RATE_LIMIT_UNAVAILABLE", "거래 기록 생성 요청 제한을 확인하지 못했습니다.", 503);
  }
  if (!result || typeof result.success !== "boolean") {
    fail("RATE_LIMIT_UNAVAILABLE", "거래 기록 생성 요청 제한 응답을 확인하지 못했습니다.", 503);
  }
  if (!result.success) {
    fail("RATE_LIMITED", "거래 기록을 너무 자주 만들었습니다. 1분 뒤 다시 시도해 주세요.", 429, { "Retry-After": "60" });
  }
}

async function enforceItemRateLimit(request: Request, environment: TradeRecordEnvironment): Promise<void> {
  const limiter = environment.TRADE_RECORD_READ_RATE_LIMITER;
  const connectingIp = request.headers.get("CF-Connecting-IP") ?? "";
  if (!limiter || !CF_CONNECTING_IP_PATTERN.test(connectingIp)) {
    fail("RATE_LIMIT_UNAVAILABLE", "거래 기록 요청을 안전하게 제한하지 못했습니다.", 503);
  }

  let result: Readonly<{ success: boolean }>;
  try {
    result = await limiter.limit({ key: `trade-record:read:${connectingIp.toLowerCase()}` });
  } catch {
    fail("RATE_LIMIT_UNAVAILABLE", "거래 기록 요청 제한을 확인하지 못했습니다.", 503);
  }
  if (!result || typeof result.success !== "boolean") {
    fail("RATE_LIMIT_UNAVAILABLE", "거래 기록 요청 제한 응답을 확인하지 못했습니다.", 503);
  }
  if (!result.success) {
    fail("RATE_LIMITED", "거래 기록 요청이 너무 많습니다. 1분 뒤 다시 시도해 주세요.", 429, { "Retry-After": "60" });
  }
}

async function verifyUpbitReferencePrice(
  submittedPriceKrw: number,
  nowMs: number,
  fetcher: typeof fetch,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPBIT_PRICE_TIMEOUT_MS);
  try {
    let requestUrl = UPBIT_PRICE_URL;
    let response: Response | null = null;
    for (let redirectCount = 0; redirectCount <= UPBIT_PRICE_MAX_REDIRECTS; redirectCount += 1) {
      response = await fetcher(requestUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "BitcoinP2PCheck/1.0 (+trade record verification)",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await cancelBody(response.body);
      if (redirectCount === UPBIT_PRICE_MAX_REDIRECTS) {
        fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 기준가 응답의 이동 횟수를 확인하지 못했습니다.", 503);
      }
      const location = response.headers.get("location");
      if (!location) fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 기준가 응답의 이동 경로를 확인하지 못했습니다.", 503);
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, requestUrl);
      } catch {
        fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 기준가 응답의 이동 경로를 확인하지 못했습니다.", 503);
      }
      const allowedUrl = new URL(UPBIT_PRICE_URL);
      const hasOnlyExpectedQuery = nextUrl.searchParams.size === 1
        && nextUrl.searchParams.get("markets") === "KRW-BTC";
      if (
        nextUrl.protocol !== "https:"
        || nextUrl.origin !== allowedUrl.origin
        || nextUrl.pathname !== allowedUrl.pathname
        || !hasOnlyExpectedQuery
      ) {
        fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 기준가 응답 경로를 확인하지 못했습니다.", 503);
      }
      requestUrl = nextUrl.toString();
    }
    if (!response) fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 기준가 응답을 확인하지 못했습니다.", 503);
    const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (response.status !== 200 || mediaType !== "application/json") {
      await cancelBody(response.body);
      fail("MARKET_VERIFICATION_UNAVAILABLE", "최신 업비트 기준가 응답을 확인하지 못했습니다.", 503);
    }
    const value = await readLimitedResponseJson(response, MAX_UPBIT_RESPONSE_BYTES);
    const ticker = Array.isArray(value) && value.length === 1 && isRecord(value[0]) ? value[0] : null;
    if (
      !ticker
      || ticker.market !== "KRW-BTC"
      || !Number.isSafeInteger(ticker.trade_price)
      || Number(ticker.trade_price) <= 0
      || !Number.isSafeInteger(ticker.trade_timestamp)
    ) {
      fail("MARKET_VERIFICATION_UNAVAILABLE", "최신 업비트 기준가 데이터 형식을 확인하지 못했습니다.", 503);
    }

    const tradeTimestamp = Number(ticker.trade_timestamp);
    const observationAgeMs = nowMs - tradeTimestamp;
    if (observationAgeMs > UPBIT_PRICE_MAX_AGE_MS || observationAgeMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
      fail("MARKET_VERIFICATION_UNAVAILABLE", "최신 업비트 기준가 시각을 확인하지 못했습니다.", 503);
    }
    const currentPriceKrw = Number(ticker.trade_price);
    const deviationRatio = Math.abs(submittedPriceKrw - currentPriceKrw) / currentPriceKrw;
    if (!Number.isFinite(deviationRatio) || deviationRatio > UPBIT_PRICE_MAX_DEVIATION_RATIO) {
      fail("REFERENCE_PRICE_MISMATCH", "기준가가 최신 업비트 가격과 1% 넘게 다릅니다. 시세를 새로고침해 주세요.", 409);
    }
  } catch (error) {
    if (error instanceof TradeRecordRequestError) throw error;
    console.error(JSON.stringify({
      event: "trade_record_market_verification_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    fail("MARKET_VERIFICATION_UNAVAILABLE", "최신 업비트 기준가를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", 503);
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyUpbitPremium(
  submittedPremiumRatio: number | null,
  nowMs: number,
  fetcher: typeof fetch,
): Promise<void> {
  if (submittedPremiumRatio === null) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPBIT_PREMIUM_TIMEOUT_MS);
  try {
    let requestUrl = UPBIT_PREMIUM_URL;
    let response: Response | null = null;
    for (let redirectCount = 0; redirectCount <= UPBIT_PRICE_MAX_REDIRECTS; redirectCount += 1) {
      response = await fetcher(requestUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "BitcoinP2PCheck/1.0 (+trade record premium verification)",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await cancelBody(response.body);
      if (redirectCount === UPBIT_PRICE_MAX_REDIRECTS) {
        fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 프리미엄 응답의 이동 횟수를 확인하지 못했습니다.", 503);
      }
      const location = response.headers.get("location");
      if (!location) fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 프리미엄 응답의 이동 경로를 확인하지 못했습니다.", 503);
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, requestUrl);
      } catch {
        fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 프리미엄 응답의 이동 경로를 확인하지 못했습니다.", 503);
      }
      const allowedUrl = new URL(UPBIT_PREMIUM_URL);
      const hasOnlyExpectedQuery = nextUrl.searchParams.size === 1
        && nextUrl.searchParams.get("symbols") === "BTC";
      if (
        nextUrl.protocol !== "https:"
        || nextUrl.origin !== allowedUrl.origin
        || nextUrl.pathname !== allowedUrl.pathname
        || !hasOnlyExpectedQuery
      ) {
        fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 프리미엄 응답 경로를 확인하지 못했습니다.", 503);
      }
      requestUrl = nextUrl.toString();
    }
    if (!response) fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 프리미엄 응답을 확인하지 못했습니다.", 503);
    const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (response.status !== 200 || mediaType !== "application/json") {
      await cancelBody(response.body);
      fail("MARKET_VERIFICATION_UNAVAILABLE", "최신 업비트 프리미엄 응답을 확인하지 못했습니다.", 503);
    }
    const value = await readLimitedResponseJson(response, MAX_UPBIT_RESPONSE_BYTES);
    const parsed = parsePremiumPayload(value, new Date(nowMs).toISOString());
    if (!parsed.ok) {
      fail("MARKET_VERIFICATION_UNAVAILABLE", "최신 업비트 프리미엄 데이터 형식을 확인하지 못했습니다.", 503);
    }
    const deviation = Math.abs(submittedPremiumRatio - parsed.value.koreaPremium);
    if (!Number.isFinite(deviation) || deviation > UPBIT_PREMIUM_MAX_ABSOLUTE_DEVIATION) {
      fail("KOREA_PREMIUM_MISMATCH", "업비트 프리미엄 참고값이 최신 데이터와 0.5%p 넘게 다릅니다. 시세를 새로고침해 주세요.", 409);
    }
  } catch (error) {
    if (error instanceof TradeRecordRequestError) throw error;
    console.error(JSON.stringify({
      event: "trade_record_premium_verification_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    fail("MARKET_VERIFICATION_UNAVAILABLE", "최신 업비트 프리미엄을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", 503);
  } finally {
    clearTimeout(timeout);
  }
}

function parsePrivateSigningJwk(value: string | undefined): PrivateSigningJwk {
  if (!value || new TextEncoder().encode(value).byteLength > MAX_PRIVATE_JWK_BYTES) {
    fail("SIGNING_UNAVAILABLE", "거래 기록 서명 서비스를 사용할 수 없습니다.", 503);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("SIGNING_UNAVAILABLE", "거래 기록 서명 설정을 확인하지 못했습니다.", 503);
  }
  if (
    !isRecord(parsed)
    || parsed.kty !== "EC"
    || parsed.crv !== "P-256"
    || typeof parsed.x !== "string"
    || !BASE64URL_COORDINATE_PATTERN.test(parsed.x)
    || typeof parsed.y !== "string"
    || !BASE64URL_COORDINATE_PATTERN.test(parsed.y)
    || typeof parsed.d !== "string"
    || !BASE64URL_PRIVATE_PATTERN.test(parsed.d)
    || typeof parsed.kid !== "string"
    || !TRADE_RECORD_KEY_ID_PATTERN.test(parsed.kid)
  ) {
    fail("SIGNING_UNAVAILABLE", "거래 기록 서명 설정을 확인하지 못했습니다.", 503);
  }
  return {
    ...parsed,
    kty: "EC",
    crv: "P-256",
    x: parsed.x,
    y: parsed.y,
    d: parsed.d,
    kid: parsed.kid,
  };
}

async function importSigningKey(jwk: PrivateSigningJwk): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    fail("SIGNING_UNAVAILABLE", "거래 기록 서명 키를 사용할 수 없습니다.", 503);
  }
}

function assertPublishedSigningKey(
  privateJwk: PrivateSigningJwk,
  publicKeys: Readonly<Record<string, TradeRecordPublicJwk>>,
): void {
  const published = publicKeys[privateJwk.kid];
  if (
    !published
    || published.kty !== "EC"
    || published.crv !== "P-256"
    || published.kid !== privateJwk.kid
    || published.x !== privateJwk.x
    || published.y !== privateJwk.y
  ) {
    fail("SIGNING_UNAVAILABLE", "거래 기록 서명 키가 이 앱의 공개키와 일치하지 않습니다.", 503);
  }
}

function canonicalizePaymentDraft(value: unknown, sats: number, createdAtMs: number): TradeRecordPayment | null {
  if (value === null) return null;
  if (!isRecord(value) || (value.rail !== "onchain" && value.rail !== "lightning")) {
    fail("INVALID_PAYMENT", "BTC 수취정보를 확인하지 못했습니다.");
  }

  if (value.rail === "onchain") {
    if (!hasExactKeys(value, ["rail", "payload", "address"]) || typeof value.payload !== "string" || typeof value.address !== "string") {
      fail("INVALID_PAYMENT", "온체인 수취정보 항목을 확인하지 못했습니다.");
    }
    try {
      const request = createOnchainRequest(value.address, BigInt(sats));
      if (value.payload !== request.address && value.payload !== request.uri) {
        fail("PAYMENT_AMOUNT_MISMATCH", "온체인 주소 또는 BIP21의 주소·금액이 거래 조건과 일치하지 않습니다.");
      }
      return Object.freeze({ rail: "onchain", payload: value.payload === request.uri ? request.uri : request.address, address: request.address });
    } catch (error) {
      if (error instanceof TradeRecordRequestError) throw error;
      fail("INVALID_PAYMENT", error instanceof Error ? error.message : "BIP21 수취정보를 확인하지 못했습니다.");
    }
  }

  if (hasExactKeys(value, ["rail", "payload", "address"]) && typeof value.payload === "string" && typeof value.address === "string") {
    let address: string;
    let payload: string;
    try {
      address = normalizeLightningAddress(value.address).address;
      payload = normalizeLightningAddress(value.payload).address;
    } catch (error) {
      if (!(error instanceof LightningAddressNormalizationError)) throw error;
      fail("INVALID_PAYMENT", "라이트닝 주소를 사용자명@도메인 형식으로 확인하지 못했습니다.");
    }
    if (payload !== address) fail("INVALID_PAYMENT", "라이트닝 주소 항목이 일치하지 않습니다.");
    return Object.freeze({ rail: "lightning", payload: address, address });
  }

  if (!hasExactKeys(value, ["rail", "payload"]) || typeof value.payload !== "string") {
    fail("INVALID_PAYMENT", "라이트닝 수취정보 항목을 확인하지 못했습니다.");
  }
  try {
    const invoice = validateBolt11Invoice(value.payload, {
      expectedSats: BigInt(sats),
      nowSeconds: Math.floor(createdAtMs / 1_000),
      minimumRemainingSeconds: MIN_LIGHTNING_PAYMENT_REMAINING_SECONDS,
    });
    return Object.freeze({
      rail: "lightning",
      payload: invoice.canonicalInvoice,
      expiresAt: new Date(invoice.expiresAt * 1_000).toISOString(),
    });
  } catch (error) {
    fail("INVALID_PAYMENT", error instanceof Error ? error.message : "BOLT11 인보이스를 확인하지 못했습니다.");
  }
}

function verificationUrl(request: Request, id: string): string {
  const url = new URL("/verify/", request.url);
  url.searchParams.set("id", id);
  return url.toString();
}

async function createRecord(
  request: Request,
  environment: TradeRecordEnvironment,
  publicKeys: Readonly<Record<string, TradeRecordPublicJwk>>,
  fetcher: typeof fetch,
): Promise<Response> {
  const records = environment.TRADE_RECORDS;
  if (!records) fail("STORAGE_UNAVAILABLE", "거래 기록 저장소를 사용할 수 없습니다.", 503);
  const body = await readLimitedJson(request);
  if (!isRecord(body) || !hasExactKeys(body, ["condition", "payment"])) fail("INVALID_REQUEST", "거래 기록 요청 항목을 확인하지 못했습니다.");

  const lifecycle = parseCreateLifecycle(request);
  const revokeToken = createRevokeToken(request);
  const tokenHash = await sha256Base64Url(revokeToken);
  const id = tokenHash.slice(0, 16);
  const existingIndex = parseManagementIndex(await records.get(managementKey(tokenHash)));
  if (existingIndex && existingIndex.id !== id) fail("STORAGE_CORRUPT", "거래 기록 관리 인덱스를 확인하지 못했습니다.", 500);
  if (existingIndex?.state === "revoked") fail("RECORD_REVOKED", "이 관리 capability로 만든 거래 기록은 폐기되었습니다.", 409);

  const existingStored = await records.get(storageKey(id));
  if (existingStored !== null) {
    const existing = parseStoredRecord(existingStored);
    if (existing.tokenHash !== tokenHash) fail("ID_CONFLICT", "거래 기록 식별자가 충돌했습니다.", 409);
    if (existing.lifecycle === "revoked") fail("RECORD_REVOKED", "이 관리 capability로 만든 거래 기록은 폐기되었습니다.", 409);
    return recordResponse(request, existing.signed, 200, {
      lifecycle: existing.lifecycle,
      revokeToken,
    });
  }

  const createdAtMs = Date.now();
  const condition = canonicalizeTradeRecordCondition(body.condition);
  assertFreshTradeRecordReference(condition, createdAtMs);
  const payment = canonicalizePaymentDraft(body.payment, condition.sats, createdAtMs);
  const privateJwk = parsePrivateSigningJwk(environment.TRADE_RECORD_SIGNING_KEY);
  assertPublishedSigningKey(privateJwk, publicKeys);
  const signingKey = await importSigningKey(privateJwk);
  await Promise.all([
    verifyUpbitReferencePrice(condition.referencePriceKrw, createdAtMs, fetcher),
    verifyUpbitPremium(condition.koreaPremiumRatio, createdAtMs, fetcher),
  ]);
  const retentionPolicy = getTradeRecordRetentionPolicy(WRITTEN_TRADE_RECORD_SCHEMA);
  const record = canonicalizeTradeRecord({
    schema: WRITTEN_TRADE_RECORD_SCHEMA,
    id,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + retentionPolicy.retentionSeconds * 1_000).toISOString(),
    condition,
    payment,
  });

  let signatureBytes: Uint8Array;
  try {
    const signingData = new Uint8Array(canonicalTradeRecordBytes(record)).buffer;
    signatureBytes = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      signingData,
    ));
  } catch {
    fail("SIGNING_UNAVAILABLE", "거래 기록에 서명하지 못했습니다.", 503);
  }
  if (signatureBytes.byteLength !== 64) fail("SIGNING_UNAVAILABLE", "거래 기록 서명 형식을 확인하지 못했습니다.", 503);

  const signed: SignedTradeRecord = Object.freeze({
    record,
    signature: base64Url(signatureBytes),
    keyId: privateJwk.kid,
  });
  const ttl = lifecycle === "pending" ? PENDING_RECORD_TTL_SECONDS : recordTtl(signed, createdAtMs);
  await records.put(storageKey(id), JSON.stringify(storedManagedRecord(signed, lifecycle, tokenHash)), {
    expirationTtl: ttl,
  });
  const afterWriteIndex = parseManagementIndex(await records.get(managementKey(tokenHash)));
  if (afterWriteIndex?.state === "revoked") {
    await records.delete(storageKey(id));
    fail("RECORD_REVOKED", "이 관리 capability로 만든 거래 기록은 폐기되었습니다.", 409);
  }

  return recordResponse(request, signed, 201, { lifecycle, revokeToken });
}

async function getRecord(request: Request, environment: TradeRecordEnvironment, id: string): Promise<Response> {
  const records = environment.TRADE_RECORDS;
  if (!records) fail("STORAGE_UNAVAILABLE", "거래 기록 저장소를 사용할 수 없습니다.", 503);
  const stored = await records.get(storageKey(id));
  if (stored === null) fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했거나 보관 기간이 끝났습니다.", 404);
  const { signed, lifecycle, tokenHash } = parseStoredRecord(stored);
  if (signed.record.id !== id) fail("STORAGE_CORRUPT", "저장된 거래 기록 식별자가 일치하지 않습니다.", 500);
  if (tokenHash) {
    const management = parseManagementIndex(await records.get(managementKey(tokenHash)));
    if (management?.state === "revoked") {
      fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했거나 보관 기간이 끝났습니다.", 404);
    }
  }
  if (lifecycle !== "finalized" || Date.parse(signed.record.expiresAt) <= Date.now()) {
    fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했거나 보관 기간이 끝났습니다.", 404);
  }

  return recordResponse(request, signed);
}

function recordResponse(
  request: Request,
  signed: SignedTradeRecord,
  status = 200,
  management?: Readonly<{ lifecycle: RecordLifecycle; revokeToken: string }>,
): Response {
  return json({
    ok: true,
    ...signed,
    id: signed.record.id,
    verificationUrl: verificationUrl(request, signed.record.id),
    ...(management ?? {}),
  }, status);
}

async function assertEmptyManagementBody(request: Request): Promise<void> {
  try {
    await readBoundedBytes(request, 0);
  } catch {
    fail("INVALID_REQUEST", "이 관리 요청에는 본문을 포함할 수 없습니다.");
  }
}

async function managementContext(
  request: Request,
  records: TradeRecordKvNamespace,
  id: string,
): Promise<Readonly<{ index: ManagementIndex | null; tokenHash: string; revokeToken: string }>> {
  const revokeToken = authorizationToken(request);
  const tokenHash = await sha256Base64Url(revokeToken);
  if (tokenHash.slice(0, 16) !== id) fail("INVALID_CAPABILITY", "거래 기록 관리 권한을 확인하지 못했습니다.", 403);
  const index = parseManagementIndex(await records.get(managementKey(tokenHash)));
  if (index && index.id !== id) fail("INVALID_CAPABILITY", "거래 기록 관리 권한을 확인하지 못했습니다.", 403);
  return { index, tokenHash, revokeToken };
}

async function finalizeRecord(request: Request, environment: TradeRecordEnvironment, id: string): Promise<Response> {
  await assertEmptyManagementBody(request);
  const records = environment.TRADE_RECORDS;
  if (!records) fail("STORAGE_UNAVAILABLE", "거래 기록 저장소를 사용할 수 없습니다.", 503);
  const management = await managementContext(request, records, id);
  if (management.index?.state === "revoked") fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했습니다.", 404);

  const stored = await records.get(storageKey(id));
  if (stored === null) fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했거나 임시 기록이 만료되었습니다.", 404);
  const parsed = parseStoredRecord(stored);
  if (parsed.tokenHash !== management.tokenHash || parsed.signed.record.id !== id) {
    fail("INVALID_CAPABILITY", "거래 기록 관리 권한을 확인하지 못했습니다.", 403);
  }
  if (parsed.lifecycle === "revoked") fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했습니다.", 404);
  const nowMs = Date.now();
  const ttl = recordTtl(parsed.signed, nowMs);
  if (parsed.lifecycle === "pending") {
    assertTradeRecordPaymentFinalizable(parsed.signed, nowMs);
    await records.put(storageKey(id), JSON.stringify(storedManagedRecord(parsed.signed, "finalized", management.tokenHash)), {
      expirationTtl: ttl,
    });
  }
  const afterWriteIndex = parseManagementIndex(await records.get(managementKey(management.tokenHash)));
  if (afterWriteIndex?.state === "revoked") {
    await records.delete(storageKey(id));
    fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했습니다.", 404);
  }
  return recordResponse(request, parsed.signed, 200, {
    lifecycle: "finalized",
    revokeToken: management.revokeToken,
  });
}

async function revokeRecord(request: Request, environment: TradeRecordEnvironment, id: string): Promise<Response> {
  await assertEmptyManagementBody(request);
  const records = environment.TRADE_RECORDS;
  if (!records) fail("STORAGE_UNAVAILABLE", "거래 기록 저장소를 사용할 수 없습니다.", 503);
  const management = await managementContext(request, records, id);

  // A previous request may have left a failed best-effort mirror operation in
  // this object instance. Drain and reset that batch before defining the
  // security-critical revocation batch below. The new batch still fails closed.
  try {
    await records.flushLegacyMirror?.();
  } catch {
    // A revocation re-writes its tombstone and record deletion, so an older
    // mirror failure does not by itself make this attempt unsafe.
  }

  const tombstoneTtlSeconds = getTradeRecordRetentionPolicy(TRADE_RECORD_SCHEMA_V1).retentionSeconds;
  const persistRevocation = async (record?: ReturnType<typeof parseStoredRecord>): Promise<void> => {
    try {
      // Re-write the tombstone even on an idempotent retry. If a previous
      // response was 503, both this put and the delete must reach legacy KV
      // before an older Worker version can safely serve traffic again.
      await records.put(
        managementKey(management.tokenHash),
        JSON.stringify({ version: 1, id, state: "revoked" }),
        { expirationTtl: tombstoneTtlSeconds },
      );
      if (record && record.lifecycle !== "revoked") {
        await records.put(
          storageKey(id),
          JSON.stringify(storedManagedRecord(record.signed, "revoked", management.tokenHash)),
          { expirationTtl: tombstoneTtlSeconds },
        );
      }
      await records.delete(storageKey(id));
      await records.flushLegacyMirror?.();
    } catch {
      fail(
        "STORAGE_UNAVAILABLE",
        "거래 기록 폐기 상태를 저장소에 반영하지 못했습니다. 같은 관리 capability로 다시 시도해 주세요.",
        503,
        { "Retry-After": "1" },
      );
    }
  };

  if (management.index?.state === "revoked") {
    await persistRevocation();
    return json({ ok: true, id, lifecycle: "revoked" });
  }

  const stored = await records.get(storageKey(id));
  let parsed: ReturnType<typeof parseStoredRecord> | null = null;
  if (stored !== null) {
    parsed = parseStoredRecord(stored);
    if (parsed.tokenHash !== management.tokenHash || parsed.signed.record.id !== id) {
      fail("INVALID_CAPABILITY", "거래 기록 관리 권한을 확인하지 못했습니다.", 403);
    }
  } else if (!management.index) {
    fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했습니다.", 404);
  }

  if (!parsed) fail("STORAGE_CORRUPT", "저장된 거래 기록을 확인하지 못했습니다.", 500);
  await persistRevocation(parsed);
  return json({ ok: true, id, lifecycle: "revoked" });
}

export function isTradeRecordApiPath(pathname: string): boolean {
  return pathname === "/api/trade-record" || pathname.startsWith("/api/trade-record/");
}

async function routeThroughTradeRecordState(
  request: Request,
  environment: TradeRecordEnvironment,
  pathname: string,
): Promise<Response> {
  let id: string;
  if (pathname === "/api/trade-record" || pathname === "/api/trade-record/") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    await enforceCreateRateLimit(request, environment);
    const tokenHash = await sha256Base64Url(createRevokeToken(request));
    id = tokenHash.slice(0, 16);
  } else {
    const finalizeMatch = /^\/api\/trade-record\/([^/]+)\/finalize\/?$/u.exec(pathname);
    if (finalizeMatch) {
      if (!isTradeRecordId(finalizeMatch[1])) fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했습니다.", 404);
      if (request.method !== "POST") return methodNotAllowed("POST");
      await enforceItemRateLimit(request, environment);
      id = finalizeMatch[1];
    } else {
      const itemMatch = /^\/api\/trade-record\/([^/]+)\/?$/u.exec(pathname);
      if (!itemMatch || !isTradeRecordId(itemMatch[1])) fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했습니다.", 404);
      if (request.method !== "GET" && request.method !== "DELETE") return methodNotAllowed("GET, DELETE");
      await enforceItemRateLimit(request, environment);
      id = itemMatch[1];
    }
  }

  const namespace = environment.TRADE_RECORD_STATE;
  if (!namespace) fail("STORAGE_UNAVAILABLE", "강한 일관성 거래 기록 저장소를 사용할 수 없습니다.", 503);

  try {
    const objectId = namespace.idFromName(id);
    return await namespace.get(objectId).fetch(request);
  } catch {
    fail("STORAGE_UNAVAILABLE", "강한 일관성 거래 기록 저장소에 연결하지 못했습니다.", 503);
  }
}

export async function handleTradeRecordRequest(
  request: Request,
  environment: TradeRecordEnvironment,
  options: TradeRecordHandlerOptions = {},
): Promise<Response> {
  let route = "unknown";
  try {
    const pathname = new URL(request.url).pathname;
    route = pathname === "/api/trade-record" || pathname === "/api/trade-record/"
      ? "collection"
      : pathname.endsWith("/finalize") || pathname.endsWith("/finalize/")
        ? "finalize"
        : "item";
    if (recordsExplicitlyDisabled(environment)) {
      if (request.method === "GET") {
        return json({ ok: false, code: "RECORD_NOT_FOUND", message: "거래 기록을 찾지 못했습니다." }, 404);
      }
      return json({ ok: false, code: "TRADE_RECORDS_DISABLED", message: "이 배포 환경에서는 거래 기록 API를 사용할 수 없습니다." }, 503);
    }
    if (options.storageMode !== "durable-object") {
      if (environment.TRADE_RECORD_STATE) {
        return await routeThroughTradeRecordState(request, environment, pathname);
      }
      if (!options.allowLegacyKv) {
        fail("STORAGE_UNAVAILABLE", "강한 일관성 거래 기록 저장소를 사용할 수 없습니다.", 503);
      }
    }

    if (pathname === "/api/trade-record" || pathname === "/api/trade-record/") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (options.storageMode !== "durable-object") await enforceCreateRateLimit(request, environment);
      return await createRecord(
        request,
        environment,
        options.publicKeys ?? TRADE_RECORD_PUBLIC_KEYS,
        options.fetcher ?? fetch,
      );
    }

    const finalizeMatch = /^\/api\/trade-record\/([^/]+)\/finalize\/?$/u.exec(pathname);
    if (finalizeMatch) {
      if (!isTradeRecordId(finalizeMatch[1])) fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했습니다.", 404);
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await finalizeRecord(request, environment, finalizeMatch[1]);
    }

    const match = /^\/api\/trade-record\/([^/]+)\/?$/u.exec(pathname);
    if (!match || !isTradeRecordId(match[1])) fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했습니다.", 404);
    if (request.method === "GET") {
      if (options.storageMode !== "durable-object" && !options.allowLegacyKv) {
        await enforceItemRateLimit(request, environment);
      }
      return await getRecord(request, environment, match[1]);
    }
    if (request.method === "DELETE") return await revokeRecord(request, environment, match[1]);
    return methodNotAllowed("GET, DELETE");
  } catch (error) {
    if (error instanceof TradeRecordRequestError) {
      return json({ ok: false, code: error.code, message: error.message }, error.status, error.headers);
    }
    if (error instanceof TradeRecordValidationError) return json({ ok: false, code: error.code, message: error.message }, 400);
    console.error(JSON.stringify({
      event: "trade_record_request_failed",
      method: request.method,
      route,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    return json({ ok: false, code: "INTERNAL_ERROR", message: "거래 기록 요청을 처리하지 못했습니다." }, 500);
  }
}
