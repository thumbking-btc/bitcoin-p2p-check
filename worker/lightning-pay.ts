import { bech32 } from "@scure/base";

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
const MAX_INVOICE_LENGTH = 1_200;
const MAX_REDIRECTS = 2;
const FETCH_TIMEOUT_MS = 7_000;
const MAX_SAFE_SATS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const LIGHTNING_USER = /^[a-z0-9._+-]{1,128}$/u;

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

function publicHostname(hostname: string) {
  if (
    !hostname
    || hostname.length > 253
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.includes(":")
    || /^\d+(?:\.\d+){3}$/u.test(hostname)
  ) return false;
  const labels = hostname.split(".");
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}

function safeHttpsUrl(input: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input, base);
  } catch {
    fail("INVALID_SOURCE", "라이트닝 수취정보의 주소를 확인하지 못했습니다.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || !publicHostname(hostname)
  ) {
    fail("INVALID_SOURCE", "공개 HTTPS 라이트닝 수취정보만 사용할 수 있습니다.");
  }
  url.hostname = hostname;
  url.hash = "";
  return url;
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
  return safeHttpsUrl(text);
}

function parseSource(raw: unknown): { discoveryUrl: URL; normalizedSource: string; sourceType: SourceType } {
  if (typeof raw !== "string") fail("INVALID_SOURCE", "라이트닝 주소 또는 LNURL-pay를 입력하십시오.");
  let source = raw.trim();
  if (!source || source.length > MAX_SOURCE_LENGTH || /[\u0000-\u001f\u007f]/u.test(source)) {
    fail("INVALID_SOURCE", "라이트닝 주소 또는 LNURL-pay를 확인하십시오.");
  }
  if (/^lightning:/iu.test(source)) source = source.slice("lightning:".length).trim();

  if (/^lnurl1/iu.test(source)) {
    return { discoveryUrl: decodeLnurl(source), normalizedSource: source, sourceType: "lnurl" };
  }

  if (/^https:\/\//iu.test(source)) {
    const url = safeHttpsUrl(source);
    return { discoveryUrl: url, normalizedSource: url.toString(), sourceType: "url" };
  }

  const address = source.toLowerCase();
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@") || at === address.length - 1) {
    fail("INVALID_SOURCE", "라이트닝 주소는 사용자명@도메인 형식이거나 LNURL-pay여야 합니다.");
  }
  const username = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!LIGHTNING_USER.test(username) || !publicHostname(domain)) {
    fail("INVALID_SOURCE", "라이트닝 주소 형식을 확인하십시오.");
  }
  return {
    discoveryUrl: safeHttpsUrl(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`),
    normalizedSource: `${username}@${domain}`,
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
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) fail("INVALID_REQUEST", "요청 내용이 너무 큽니다.", 413);
  const text = await request.text();
  if (!text || new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) fail("INVALID_REQUEST", "요청 내용을 확인하지 못했습니다.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("INVALID_REQUEST", "요청 내용을 확인하지 못했습니다.");
  }
}

async function fetchJson(start: URL): Promise<unknown> {
  let current = safeHttpsUrl(start);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        headers: REQUEST_HEADERS,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        fail("PROVIDER_TIMEOUT", "라이트닝 지갑 서비스의 응답 시간이 초과되었습니다.", 504);
      }
      fail("PROVIDER_UNAVAILABLE", "라이트닝 지갑 서비스에 연결하지 못했습니다.", 502);
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects >= MAX_REDIRECTS) fail("INVALID_PROVIDER_RESPONSE", "라이트닝 지갑 서비스의 이동 경로를 확인하지 못했습니다.", 502);
      current = safeHttpsUrl(location, current);
      continue;
    }
    if (!response.ok) {
      fail(response.status === 404 ? "SOURCE_NOT_FOUND" : "PROVIDER_UNAVAILABLE", response.status === 404 ? "이 라이트닝 수취정보를 찾지 못했습니다." : "라이트닝 지갑 서비스가 요청을 처리하지 못했습니다.", response.status === 404 ? 404 : 502);
    }
    const text = await response.text();
    if (!text || text.length > MAX_JSON_BYTES) fail("INVALID_PROVIDER_RESPONSE", "라이트닝 지갑 서비스의 응답 형식을 확인하지 못했습니다.", 502);
    try {
      return JSON.parse(text) as unknown;
    } catch {
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

export async function handleLightningPayRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "POST 요청만 사용할 수 있습니다." }, 405);

  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      fail("INVALID_REQUEST", "JSON 요청만 사용할 수 있습니다.");
    }
    const body = await readJson(request);
    if (!isRecord(body)) fail("INVALID_REQUEST", "요청 내용을 확인하지 못했습니다.");

    const { discoveryUrl, normalizedSource, sourceType } = parseSource(body.source);
    const amountSats = parseAmount(body.amountSats);
    const amountMsat = amountSats * 1_000;

    const discovery = await fetchJson(discoveryUrl);
    if (!isRecord(discovery)) fail("INVALID_PROVIDER_RESPONSE", "LNURL-pay 정보를 확인하지 못했습니다.", 502);
    if (discovery.status === "ERROR") fail("SOURCE_REJECTED", safeReason(discovery.reason, "라이트닝 수취정보가 요청을 거절했습니다."), 422);
    if (discovery.tag !== "payRequest") fail("NOT_PAY_REQUEST", "이 LNURL은 결제 수취용 LNURL-pay가 아닙니다.", 422);

    const minSendable = Number(discovery.minSendable);
    const maxSendable = Number(discovery.maxSendable);
    if (!Number.isSafeInteger(minSendable) || !Number.isSafeInteger(maxSendable) || minSendable < 1 || maxSendable < minSendable) {
      fail("INVALID_PROVIDER_RESPONSE", "수취 가능한 금액 범위를 확인하지 못했습니다.", 502);
    }
    if (amountMsat < minSendable || amountMsat > maxSendable) {
      fail("AMOUNT_NOT_SUPPORTED", `이 수취정보는 ${Math.ceil(minSendable / 1_000).toLocaleString("ko-KR")}~${Math.floor(maxSendable / 1_000).toLocaleString("ko-KR")} sats만 받을 수 있습니다.`, 422);
    }
    if (typeof discovery.callback !== "string") fail("INVALID_PROVIDER_RESPONSE", "인보이스 발급 주소를 확인하지 못했습니다.", 502);

    const callback = safeHttpsUrl(discovery.callback);
    callback.searchParams.set("amount", String(amountMsat));
    const payment = await fetchJson(callback);
    if (!isRecord(payment)) fail("INVALID_PROVIDER_RESPONSE", "인보이스 응답을 확인하지 못했습니다.", 502);
    if (payment.status === "ERROR") fail("INVOICE_REJECTED", safeReason(payment.reason, "지갑 서비스가 인보이스 발급을 거절했습니다."), 422);

    const invoice = payment.pr;
    if (typeof invoice !== "string" || invoice.length < 20 || invoice.length > MAX_INVOICE_LENGTH || /\s/u.test(invoice) || !invoice.toLowerCase().startsWith("lnbc")) {
      fail("INVALID_PROVIDER_RESPONSE", "지갑 서비스가 올바른 메인넷 BOLT11 인보이스를 반환하지 않았습니다.", 502);
    }

    return json({ ok: true, amountSats, invoice, normalizedSource, sourceType });
  } catch (error) {
    if (error instanceof LightningPayError) return json({ ok: false, code: error.code, message: error.message }, error.status);
    return json({ ok: false, code: "INTERNAL_ERROR", message: "라이트닝 결제 요청을 만들지 못했습니다." }, 500);
  }
}
