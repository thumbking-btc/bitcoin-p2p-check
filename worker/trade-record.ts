import { validateBolt11Invoice } from "../app/lib/bolt11-invoice.mjs";
import { createOnchainRequest } from "../app/lib/onchain-request.mjs";
import {
  TRADE_RECORD_PUBLIC_KEYS,
  type TradeRecordPublicJwk,
// @ts-expect-error -- Node 22's native TypeScript test runner requires the explicit extension; this project emits no JS through tsc.
} from "../app/lib/trade-record-verification.ts";
import {
  assertFreshTradeRecordReference,
  canonicalTradeRecordBytes,
  canonicalizeSignedTradeRecord,
  canonicalizeTradeRecord,
  canonicalizeTradeRecordCondition,
  isTradeRecordId,
  TRADE_RECORD_KEY_ID_PATTERN,
  TRADE_RECORD_RETENTION_SECONDS,
  TRADE_RECORD_SCHEMA,
  TradeRecordValidationError,
  type SignedTradeRecord,
  type TradeRecordPayment,
// @ts-expect-error -- Node 22's native TypeScript test runner requires the explicit extension; this project emits no JS through tsc.
} from "../app/lib/trade-record.ts";

const API_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const MAX_REQUEST_BYTES = 8_192;
const MAX_PRIVATE_JWK_BYTES = 2_048;
const MAX_UPBIT_RESPONSE_BYTES = 16_384;
const MIN_LIGHTNING_REMAINING_SECONDS = 120;
const RECORD_KEY_PREFIX = "trade-record:v1:";
const UPBIT_PRICE_URL = "https://api.upbit.com/v1/ticker?markets=KRW-BTC";
const UPBIT_PRICE_TIMEOUT_MS = 4_000;
const UPBIT_PRICE_MAX_AGE_MS = 2 * 60_000;
const UPBIT_PRICE_MAX_DEVIATION_RATIO = 0.01;
const UPBIT_PRICE_MAX_REDIRECTS = 2;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;
const BASE64URL_COORDINATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_PRIVATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CF_CONNECTING_IP_PATTERN = /^[0-9A-Fa-f:.]{3,64}$/u;

export interface TradeRecordKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: Readonly<{ expirationTtl: number }>): Promise<void>;
}

export interface TradeRecordRateLimit {
  limit(options: Readonly<{ key: string }>): Promise<Readonly<{ success: boolean }>>;
}

export interface TradeRecordEnvironment {
  TRADE_RECORDS?: TradeRecordKvNamespace;
  TRADE_RECORD_CREATE_RATE_LIMITER?: TradeRecordRateLimit;
  /** Secret: JSON-encoded private P-256 JWK with a public `kid`. */
  TRADE_RECORD_SIGNING_KEY?: string;
}

export type TradeRecordHandlerOptions = Readonly<{
  /** Test seam only. Production callers must use the committed public-key map. */
  publicKeys?: Readonly<Record<string, TradeRecordPublicJwk>>;
  /** Test seam only. Production callers use the global fetch implementation. */
  fetcher?: typeof fetch;
}>;

class TradeRecordRequestError extends Error {
  readonly code: string;
  readonly headers?: HeadersInit;
  readonly status: number;

  constructor(code: string, message: string, status = 400, headers?: HeadersInit) {
    super(message);
    this.name = "TradeRecordRequestError";
    this.code = code;
    this.headers = headers;
    this.status = status;
  }
}

type PrivateSigningJwk = JsonWebKey & {
  crv: "P-256";
  d: string;
  kid: string;
  kty: "EC";
  x: string;
  y: string;
};

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(API_HEADERS);
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { status, headers });
}

function fail(code: string, message: string, status = 400, headers?: HeadersInit): never {
  throw new TradeRecordRequestError(code, message, status, headers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) fail("REQUEST_TOO_LARGE", "요청 내용이 너무 큽니다.", 413);
  if (!request.body) fail("INVALID_REQUEST", "요청 내용을 확인하지 못했습니다.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_REQUEST_BYTES) {
        await reader.cancel();
        fail("REQUEST_TOO_LARGE", "요청 내용이 너무 큽니다.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    fail("INVALID_REQUEST", "요청 JSON을 확인하지 못했습니다.");
  }
}

async function readLimitedResponseJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.body) fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 기준가 응답을 확인하지 못했습니다.", 503);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        try {
          await reader.cancel("response too large");
        } catch {
          // Keep the bounded-response error if cancellation also fails.
        }
        fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 기준가 응답이 너무 큽니다.", 503);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (received === 0) fail("MARKET_VERIFICATION_UNAVAILABLE", "업비트 기준가 응답을 확인하지 못했습니다.", 503);
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
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
      message: "trade_record_market_verification_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    }));
    fail("MARKET_VERIFICATION_UNAVAILABLE", "최신 업비트 기준가를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", 503);
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

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function randomRecordId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function storageKey(id: string): string {
  return `${RECORD_KEY_PREFIX}${id}`;
}

async function unusedRecordId(records: TradeRecordKvNamespace): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = randomRecordId();
    if (await records.get(storageKey(id)) === null) return id;
  }
  fail("ID_UNAVAILABLE", "거래 기록 식별자를 만들지 못했습니다.", 503);
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
      if (request.uri !== value.payload) fail("PAYMENT_AMOUNT_MISMATCH", "BIP21의 주소·금액이 거래 조건과 일치하지 않습니다.");
      return Object.freeze({ rail: "onchain", payload: request.uri, address: request.address });
    } catch (error) {
      if (error instanceof TradeRecordRequestError) throw error;
      fail("INVALID_PAYMENT", error instanceof Error ? error.message : "BIP21 수취정보를 확인하지 못했습니다.");
    }
  }

  if (!hasExactKeys(value, ["rail", "payload"]) || typeof value.payload !== "string") {
    fail("INVALID_PAYMENT", "라이트닝 수취정보 항목을 확인하지 못했습니다.");
  }
  try {
    const invoice = validateBolt11Invoice(value.payload, {
      expectedSats: BigInt(sats),
      nowSeconds: Math.floor(createdAtMs / 1_000),
      minimumRemainingSeconds: MIN_LIGHTNING_REMAINING_SECONDS,
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
  const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    fail("INVALID_REQUEST", "JSON 요청만 사용할 수 있습니다.", 415);
  }
  const records = environment.TRADE_RECORDS;
  if (!records) fail("STORAGE_UNAVAILABLE", "거래 기록 저장소를 사용할 수 없습니다.", 503);
  const body = await readLimitedJson(request);
  if (!isRecord(body) || !hasExactKeys(body, ["condition", "payment"])) fail("INVALID_REQUEST", "거래 기록 요청 항목을 확인하지 못했습니다.");

  const createdAtMs = Date.now();
  const condition = canonicalizeTradeRecordCondition(body.condition);
  assertFreshTradeRecordReference(condition, createdAtMs);
  const payment = canonicalizePaymentDraft(body.payment, condition.sats, createdAtMs);
  const privateJwk = parsePrivateSigningJwk(environment.TRADE_RECORD_SIGNING_KEY);
  assertPublishedSigningKey(privateJwk, publicKeys);
  const signingKey = await importSigningKey(privateJwk);
  await verifyUpbitReferencePrice(condition.referencePriceKrw, createdAtMs, fetcher);
  const id = await unusedRecordId(records);
  const record = canonicalizeTradeRecord({
    schema: TRADE_RECORD_SCHEMA,
    id,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + TRADE_RECORD_RETENTION_SECONDS * 1_000).toISOString(),
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
  await records.put(storageKey(id), JSON.stringify(signed), { expirationTtl: TRADE_RECORD_RETENTION_SECONDS });

  return json({
    ok: true,
    ...signed,
    id,
    verificationUrl: verificationUrl(request, id),
  }, 201);
}

async function getRecord(request: Request, environment: TradeRecordEnvironment, id: string): Promise<Response> {
  const records = environment.TRADE_RECORDS;
  if (!records) fail("STORAGE_UNAVAILABLE", "거래 기록 저장소를 사용할 수 없습니다.", 503);
  const stored = await records.get(storageKey(id));
  if (stored === null) fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했거나 보관 기간이 끝났습니다.", 404);
  if (new TextEncoder().encode(stored).byteLength > 8_192) fail("STORAGE_CORRUPT", "저장된 거래 기록을 확인하지 못했습니다.", 500);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored) as unknown;
  } catch {
    fail("STORAGE_CORRUPT", "저장된 거래 기록을 확인하지 못했습니다.", 500);
  }
  let signed: SignedTradeRecord;
  try {
    signed = canonicalizeSignedTradeRecord(parsed);
  } catch {
    fail("STORAGE_CORRUPT", "저장된 거래 기록을 확인하지 못했습니다.", 500);
  }
  if (signed.record.id !== id) fail("STORAGE_CORRUPT", "저장된 거래 기록 식별자가 일치하지 않습니다.", 500);

  return json({
    ok: true,
    ...signed,
    id,
    verificationUrl: verificationUrl(request, id),
  });
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: `${allow} 요청만 사용할 수 있습니다.` }, 405, { Allow: allow });
}

export function isTradeRecordApiPath(pathname: string): boolean {
  return pathname === "/api/trade-record" || pathname.startsWith("/api/trade-record/");
}

export async function handleTradeRecordRequest(
  request: Request,
  environment: TradeRecordEnvironment,
  options: TradeRecordHandlerOptions = {},
): Promise<Response> {
  try {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/trade-record" || pathname === "/api/trade-record/") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      await enforceCreateRateLimit(request, environment);
      return await createRecord(
        request,
        environment,
        options.publicKeys ?? TRADE_RECORD_PUBLIC_KEYS,
        options.fetcher ?? fetch,
      );
    }

    const match = /^\/api\/trade-record\/([^/]+)\/?$/u.exec(pathname);
    if (!match || !isTradeRecordId(match[1])) fail("RECORD_NOT_FOUND", "거래 기록을 찾지 못했습니다.", 404);
    if (request.method !== "GET") return methodNotAllowed("GET");
    return await getRecord(request, environment, match[1]);
  } catch (error) {
    if (error instanceof TradeRecordRequestError) {
      return json({ ok: false, code: error.code, message: error.message }, error.status, error.headers);
    }
    if (error instanceof TradeRecordValidationError) return json({ ok: false, code: error.code, message: error.message }, 400);
    console.error(JSON.stringify({
      message: "trade_record_request_failed",
      method: request.method,
      path: new URL(request.url).pathname,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    return json({ ok: false, code: "INTERNAL_ERROR", message: "거래 기록 요청을 처리하지 못했습니다." }, 500);
  }
}
