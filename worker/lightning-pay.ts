import { bech32 } from "@scure/base";
import { BoundedBodyError, cancelBody, readBoundedJson } from "./http-body.ts";
import {
  isSameOrSubdomain,
  LightningAddressNormalizationError,
  normalizeLightningAddress,
  safePublicHttpsUrl,
} from "./lightning-address-normalize.ts";
import {
  canonicalLnurlPayInvoice,
  lnurlPayMetadataHash,
  mandatoryPayerDataLabels,
} from "./lnurl-pay-discovery.ts";
import { checkLightningRateLimit, type LightningRequestEnvironment } from "./lightning-rate-limit.ts";

const API_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const REQUEST_HEADERS = {
  Accept: "application/json",
  "User-Agent": "BitcoinP2PCheck/2.0 (+LNURL-pay request)",
};

const MAX_REQUEST_BYTES = 4_096;
const MAX_JSON_BYTES = 256_000;
const MAX_SOURCE_LENGTH = 2_048;
const MAX_REDIRECTS = 2;
const PROVIDER_DEADLINE_MS = 12_000;
const MAX_SAFE_SATS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

type SourceType = "address" | "lnurl" | "url";

class LightningPayError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "LightningPayError";
    this.code = code;
    this.status = status;
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: API_HEADERS });
}

function fail(code: string, message: string, status = 400): never {
  throw new LightningPayError(code, message, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceUrl(input: string | URL, base?: URL): URL {
  try {
    return safePublicHttpsUrl(input, base);
  } catch {
    fail("INVALID_SOURCE", "라이트닝 수취정보의 주소를 확인하지 못했습니다.");
  }
}

function providerUrl(input: string | URL, base?: URL): URL {
  try {
    return safePublicHttpsUrl(input, base);
  } catch {
    fail("INVALID_PROVIDER_RESPONSE", "라이트닝 지갑 서비스의 응답 주소를 확인하지 못했습니다.", 502);
  }
}

function decodeLnurl(value: string): URL {
  const candidate = value.trim();
  if (candidate !== candidate.toLowerCase() && candidate !== candidate.toUpperCase()) {
    fail("INVALID_LNURL", "대소문자가 섞인 LNURL은 사용할 수 없습니다.");
  }
  let decoded;
  try {
    decoded = bech32.decode(candidate.toLowerCase(), false);
  } catch {
    fail("INVALID_LNURL", "LNURL 형식 또는 체크섬을 확인하지 못했습니다.");
  }
  if (decoded.prefix !== "lnurl") fail("INVALID_LNURL", "LNURL-pay 형식을 확인하지 못했습니다.");

  let bytes: Uint8Array;
  try {
    bytes = bech32.fromWords(decoded.words);
  } catch {
    fail("INVALID_LNURL", "LNURL 데이터 형식을 확인하지 못했습니다.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_LNURL", "LNURL 주소를 읽지 못했습니다.");
  }
  return sourceUrl(text);
}

function parseSource(raw: unknown): { discoveryUrl: URL; normalizedSource: string; sourceType: SourceType } {
  if (typeof raw !== "string") fail("INVALID_SOURCE", "라이트닝 주소 또는 LNURL-pay를 입력하십시오.");
  let source = raw;
  if (!source || source.length > MAX_SOURCE_LENGTH || source !== source.trim() || /[\u0000-\u001f\u007f]/u.test(source)) {
    fail("INVALID_SOURCE", "라이트닝 주소 또는 LNURL-pay를 확인하십시오.");
  }
  if (/^lightning:/iu.test(source)) source = source.slice("lightning:".length).trim();

  if (/^lnurl1/iu.test(source)) {
    return { discoveryUrl: decodeLnurl(source), normalizedSource: source, sourceType: "lnurl" };
  }

  if (/^https:\/\//iu.test(source)) {
    const url = sourceUrl(source);
    return { discoveryUrl: url, normalizedSource: url.toString(), sourceType: "url" };
  }

  let normalized: ReturnType<typeof normalizeLightningAddress>;
  try {
    normalized = normalizeLightningAddress(source);
  } catch (error) {
    if (!(error instanceof LightningAddressNormalizationError)) throw error;
    fail("INVALID_SOURCE", "라이트닝 주소 형식을 확인하십시오.");
  }
  const { address, username, domain } = normalized;
  return {
    discoveryUrl: sourceUrl(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`),
    normalizedSource: address,
    sourceType: "address",
  };
}

function parseAmount(value: unknown) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_SAFE_SATS) {
    fail("INVALID_AMOUNT", `받을 금액은 1~${MAX_SAFE_SATS.toLocaleString("en-US")} sats 범위여야 합니다.`);
  }
  return amount;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await readBoundedJson(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BoundedBodyError && error.failure === "too-large") {
      fail("INVALID_REQUEST", "요청 내용이 너무 큽니다.", 413);
    }
    fail("INVALID_REQUEST", "요청 내용을 확인하지 못했습니다.");
  }
}

async function fetchJson(start: URL, signal: AbortSignal): Promise<{ value: unknown; finalUrl: URL }> {
  let current = providerUrl(start);
  const anchorHostname = current.hostname;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        headers: REQUEST_HEADERS,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        fail("PROVIDER_TIMEOUT", "라이트닝 지갑 서비스의 응답 시간이 초과되었습니다.", 504);
      }
      fail("PROVIDER_UNAVAILABLE", "라이트닝 지갑 서비스에 연결하지 못했습니다.", 502);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      cancelBody(response.body);
      const location = response.headers.get("location");
      if (!location || redirects >= MAX_REDIRECTS) fail("INVALID_PROVIDER_RESPONSE", "라이트닝 지갑 서비스의 이동 경로를 확인하지 못했습니다.", 502);
      const next = providerUrl(location, current);
      if (!isSameOrSubdomain(next.hostname, anchorHostname)) {
        fail("INVALID_PROVIDER_RESPONSE", "라이트닝 지갑 서비스의 이동 도메인을 확인하지 못했습니다.", 502);
      }
      current = next;
      continue;
    }
    if (!response.ok) {
      cancelBody(response.body);
      fail(response.status === 404 ? "SOURCE_NOT_FOUND" : "PROVIDER_UNAVAILABLE", response.status === 404 ? "이 라이트닝 수취정보를 찾지 못했습니다." : "라이트닝 지갑 서비스가 요청을 처리하지 못했습니다.", response.status === 404 ? 404 : 502);
    }
    try {
      return { value: await readBoundedJson(response, MAX_JSON_BYTES, signal), finalUrl: current };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        fail("PROVIDER_TIMEOUT", "라이트닝 지갑 서비스의 응답 시간이 초과되었습니다.", 504);
      }
      if (error instanceof BoundedBodyError && error.failure === "too-large") {
        fail("INVALID_PROVIDER_RESPONSE", "라이트닝 지갑 서비스의 응답이 너무 큽니다.", 502);
      }
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 지갑 서비스가 올바른 JSON을 반환하지 않았습니다.", 502);
    }
  }
  fail("INVALID_PROVIDER_RESPONSE", "라이트닝 지갑 서비스의 응답을 확인하지 못했습니다.", 502);
}

function safeReason(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, 180) : fallback;
}

export async function handleLightningPayRequest(
  request: Request,
  environment?: LightningRequestEnvironment,
): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "POST 요청만 사용할 수 있습니다." }, 405);

  try {
    const rateLimit = await checkLightningRateLimit(request, environment);
    if (rateLimit === "unavailable") fail("RATE_LIMIT_UNAVAILABLE", "요청 제한 서비스를 사용할 수 없습니다.", 503);
    if (rateLimit === "limited") fail("RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도하십시오.", 429);
    const body = await readJson(request);
    if (!isRecord(body)) fail("INVALID_REQUEST", "요청 내용을 확인하지 못했습니다.");

    const { discoveryUrl, normalizedSource, sourceType } = parseSource(body.source);
    const amountSats = parseAmount(body.amountSats);
    const amountMsat = amountSats * 1_000;

    const providerDeadline = AbortSignal.timeout(PROVIDER_DEADLINE_MS);
    const discoveryResult = await fetchJson(discoveryUrl, providerDeadline);
    const discovery = discoveryResult.value;
    if (!isRecord(discovery)) fail("INVALID_PROVIDER_RESPONSE", "LNURL-pay 정보를 확인하지 못했습니다.", 502);
    if (discovery.status === "ERROR") fail("SOURCE_REJECTED", safeReason(discovery.reason, "라이트닝 수취정보가 요청을 거절했습니다."), 422);
    if (discovery.tag !== "payRequest") fail("NOT_PAY_REQUEST", "이 LNURL은 결제 수취용 LNURL-pay가 아닙니다.", 422);
    const metadataHash = lnurlPayMetadataHash(discovery.metadata);
    if (metadataHash === null) {
      fail("INVALID_PROVIDER_RESPONSE", "LNURL-pay 결제 설명을 확인하지 못했습니다.", 502);
    }
    const requiredPayerData = mandatoryPayerDataLabels(discovery);
    if (requiredPayerData.length > 0) {
      fail(
        "PAYER_DATA_REQUIRED",
        `이 LNURL-pay는 결제자 추가 정보(${requiredPayerData.join(", ")})를 필수로 요구합니다. 자동 인보이스 대신 지갑에서 인보이스를 직접 만들어 입력하십시오.`,
        422,
      );
    }

    const minSendable = Number(discovery.minSendable);
    const maxSendable = Number(discovery.maxSendable);
    if (!Number.isSafeInteger(minSendable) || !Number.isSafeInteger(maxSendable) || minSendable < 1 || maxSendable < minSendable) {
      fail("INVALID_PROVIDER_RESPONSE", "수취 가능한 금액 범위를 확인하지 못했습니다.", 502);
    }
    if (amountMsat < minSendable || amountMsat > maxSendable) {
      fail("AMOUNT_NOT_SUPPORTED", `이 수취정보는 ${Math.ceil(minSendable / 1_000).toLocaleString("ko-KR")}~${Math.floor(maxSendable / 1_000).toLocaleString("ko-KR")} sats만 받을 수 있습니다.`, 422);
    }
    if (typeof discovery.callback !== "string") fail("INVALID_PROVIDER_RESPONSE", "인보이스 발급 주소를 확인하지 못했습니다.", 502);

    const callback = providerUrl(discovery.callback);
    if (!isSameOrSubdomain(callback.hostname, discoveryResult.finalUrl.hostname)) {
      fail("INVALID_PROVIDER_RESPONSE", "인보이스 발급 도메인을 확인하지 못했습니다.", 502);
    }
    callback.searchParams.set("amount", String(amountMsat));
    const payment = (await fetchJson(callback, providerDeadline)).value;
    if (!isRecord(payment)) fail("INVALID_PROVIDER_RESPONSE", "인보이스 응답을 확인하지 못했습니다.", 502);
    if (payment.status === "ERROR") fail("INVOICE_REJECTED", safeReason(payment.reason, "지갑 서비스가 인보이스 발급을 거절했습니다."), 422);

    const invoice = canonicalLnurlPayInvoice(payment.pr, amountSats, metadataHash);
    if (invoice === null) {
      fail("INVALID_PROVIDER_RESPONSE", "지갑 서비스가 올바른 메인넷 BOLT11 인보이스를 반환하지 않았습니다.", 502);
    }

    return json({ ok: true, amountSats, invoice, normalizedSource, sourceType });
  } catch (error) {
    if (error instanceof LightningPayError) return json({ ok: false, code: error.code, message: error.message }, error.status);
    console.error(JSON.stringify({
      event: "lightning_pay_request_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    return json({ ok: false, code: "INTERNAL_ERROR", message: "라이트닝 결제 요청을 만들지 못했습니다." }, 500);
  }
}
