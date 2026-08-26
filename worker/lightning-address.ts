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

const REQUEST_HEADERS = {
  Accept: "application/json",
  "User-Agent": "BitcoinP2PCheck/2.0 (+lightning address invoice request)",
};

const API_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const PROVIDER_DEADLINE_MS = 12_000;
const MAX_REDIRECTS = 2;
const MAX_REQUEST_BYTES = 2_048;
const MAX_JSON_BYTES = 256_000;
const MAX_SAFE_SATS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

class LightningAddressRequestError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "LightningAddressRequestError";
    this.code = code;
    this.status = status;
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: API_HEADERS });
}

function fail(code: string, message: string, status = 400): never {
  throw new LightningAddressRequestError(code, message, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providerUrl(input: string | URL, base?: URL): URL {
  try {
    return safePublicHttpsUrl(input, base);
  } catch {
    fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자의 응답 주소를 확인하지 못했습니다.", 502);
  }
}

function normalizedAddress(value: unknown): { address: string; username: string; domain: string } {
  try {
    return normalizeLightningAddress(value);
  } catch (error) {
    if (!(error instanceof LightningAddressNormalizationError)) throw error;
    fail("INVALID_ADDRESS", "라이트닝 주소를 확인하십시오.");
  }
}

function parseAmountSats(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_SAFE_SATS) {
    fail("INVALID_AMOUNT", `받을 금액은 1~${MAX_SAFE_SATS.toLocaleString("en-US")} sats 범위여야 합니다.`);
  }
  return amount;
}

function finiteSafeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readRequestJson(request: Request): Promise<unknown> {
  try {
    return await readBoundedJson(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BoundedBodyError && error.failure === "too-large") {
      fail("INVALID_REQUEST", "요청 내용이 너무 큽니다.", 413);
    }
    fail("INVALID_REQUEST", "요청 내용을 확인하지 못했습니다.");
  }
}

async function fetchJson(url: URL, signal: AbortSignal): Promise<{ value: unknown; finalUrl: URL }> {
  let current = providerUrl(url);
  const anchorHostname = current.hostname;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
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
        fail("PROVIDER_TIMEOUT", "라이트닝 주소 제공자의 응답 시간이 초과되었습니다.", 504);
      }
      fail("PROVIDER_UNAVAILABLE", "라이트닝 주소 제공자에 연결하지 못했습니다.", 502);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      cancelBody(response.body);
      const location = response.headers.get("location");
      if (!location || redirectCount >= MAX_REDIRECTS) {
        fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자의 이동 경로를 확인하지 못했습니다.", 502);
      }
      const next = providerUrl(location, current);
      if (!isSameOrSubdomain(next.hostname, anchorHostname)) {
        fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자의 이동 도메인을 확인하지 못했습니다.", 502);
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      cancelBody(response.body);
      fail(
        response.status === 404 ? "ADDRESS_NOT_FOUND" : "PROVIDER_UNAVAILABLE",
        response.status === 404
          ? "이 라이트닝 주소를 찾지 못했습니다."
          : "라이트닝 주소 제공자가 요청을 처리하지 못했습니다.",
        response.status === 404 ? 404 : 502,
      );
    }

    try {
      return { value: await readBoundedJson(response, MAX_JSON_BYTES, signal), finalUrl: current };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        fail("PROVIDER_TIMEOUT", "라이트닝 주소 제공자의 응답 시간이 초과되었습니다.", 504);
      }
      if (error instanceof BoundedBodyError && error.failure === "too-large") {
        fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자의 응답이 너무 큽니다.", 502);
      }
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자가 올바른 JSON을 반환하지 않았습니다.", 502);
    }
  }

  fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자의 응답을 확인하지 못했습니다.", 502);
}

function providerReason(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, 180) : fallback;
}

export async function handleLightningAddressRequest(
  request: Request,
  environment?: LightningRequestEnvironment,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "POST 요청만 사용할 수 있습니다." }, 405);
  }

  try {
    const rateLimit = await checkLightningRateLimit(request, environment);
    if (rateLimit === "unavailable") fail("RATE_LIMIT_UNAVAILABLE", "요청 제한 서비스를 사용할 수 없습니다.", 503);
    if (rateLimit === "limited") fail("RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도하십시오.", 429);
    const body = await readRequestJson(request);
    if (!isRecord(body)) fail("INVALID_REQUEST", "요청 내용을 확인하지 못했습니다.");

    const { address, username, domain } = normalizedAddress(body.address);
    const amountSats = parseAmountSats(body.amountSats);
    const amountMsat = amountSats * 1_000;

    const discoveryUrl = providerUrl(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`);
    const providerDeadline = AbortSignal.timeout(PROVIDER_DEADLINE_MS);
    const discoveryResult = await fetchJson(discoveryUrl, providerDeadline);
    const discovery = discoveryResult.value;
    if (!isRecord(discovery)) {
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자의 응답을 확인하지 못했습니다.", 502);
    }
    if (discovery.status === "ERROR") {
      fail("ADDRESS_REJECTED", providerReason(discovery.reason, "이 라이트닝 주소가 요청을 거절했습니다."), 422);
    }
    if (discovery.tag !== "payRequest") {
      fail("UNSUPPORTED_ADDRESS", "이 주소는 LNURL-pay 라이트닝 주소가 아닙니다.", 422);
    }
    const metadataHash = lnurlPayMetadataHash(discovery.metadata);
    if (metadataHash === null) {
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소의 결제 설명을 확인하지 못했습니다.", 502);
    }

    const requiredPayerData = mandatoryPayerDataLabels(discovery);
    if (requiredPayerData.length > 0) {
      fail(
        "PAYER_DATA_REQUIRED",
        `이 라이트닝 주소는 결제자 추가 정보(${requiredPayerData.join(", ")})를 필수로 요구합니다. 자동 인보이스 대신 지갑에서 인보이스를 직접 만들어 입력하십시오.`,
        422,
      );
    }

    const minSendable = finiteSafeInteger(discovery.minSendable);
    const maxSendable = finiteSafeInteger(discovery.maxSendable);
    if (
      minSendable === null
      || maxSendable === null
      || minSendable < 1
      || maxSendable < minSendable
    ) {
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소의 수취 금액 범위를 확인하지 못했습니다.", 502);
    }
    if (amountMsat < minSendable || amountMsat > maxSendable) {
      fail(
        "AMOUNT_NOT_SUPPORTED",
        `이 주소는 ${Math.ceil(minSendable / 1_000).toLocaleString("ko-KR")}~${Math.floor(maxSendable / 1_000).toLocaleString("ko-KR")} sats만 받을 수 있습니다.`,
        422,
      );
    }
    if (typeof discovery.callback !== "string") {
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소의 인보이스 발급 주소가 없습니다.", 502);
    }

    const callbackUrl = providerUrl(discovery.callback);
    if (!isSameOrSubdomain(callbackUrl.hostname, discoveryResult.finalUrl.hostname)) {
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소의 인보이스 발급 도메인을 확인하지 못했습니다.", 502);
    }
    callbackUrl.searchParams.set("amount", String(amountMsat));
    const invoiceResponse = (await fetchJson(callbackUrl, providerDeadline)).value;
    if (!isRecord(invoiceResponse)) {
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 인보이스 응답을 확인하지 못했습니다.", 502);
    }
    if (invoiceResponse.status === "ERROR") {
      fail("INVOICE_REJECTED", providerReason(invoiceResponse.reason, "지갑 서비스가 인보이스 발급을 거절했습니다."), 422);
    }

    const invoice = canonicalLnurlPayInvoice(invoiceResponse.pr, amountSats, metadataHash);
    if (invoice === null) {
      fail("INVALID_PROVIDER_RESPONSE", "지갑 서비스가 올바른 메인넷 BOLT11 인보이스를 반환하지 않았습니다.", 502);
    }

    return json({
      ok: true,
      address,
      amountSats,
      invoice,
      provider: domain,
    });
  } catch (error) {
    if (error instanceof LightningAddressRequestError) {
      return json({ ok: false, code: error.code, message: error.message }, error.status);
    }
    console.error(JSON.stringify({
      event: "lightning_address_request_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    return json({ ok: false, code: "INTERNAL_ERROR", message: "라이트닝 결제 요청을 만들지 못했습니다." }, 500);
  }
}
