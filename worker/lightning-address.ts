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

const DISCOVERY_TIMEOUT_MS = 5_000;
const INVOICE_TIMEOUT_MS = 7_000;
const MAX_REDIRECTS = 2;
const MAX_REQUEST_BYTES = 2_048;
const MAX_JSON_BYTES = 256_000;
const MAX_LIGHTNING_ADDRESS_LENGTH = 320;
const MAX_INVOICE_LENGTH = 1_200;
const MAX_SAFE_SATS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
const USERNAME_PATTERN = /^[a-z0-9._+-]{1,128}$/u;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const PAYER_DATA_LABELS: Record<string, string> = {
  name: "이름",
  pubkey: "공개키",
  identifier: "라이트닝 주소",
  email: "이메일",
  auth: "인증정보",
};

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

function publicHostname(hostname: string): boolean {
  if (
    !hostname
    || hostname.length > 253
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.includes(":")
    || /^\d+(?:\.\d+){3}$/u.test(hostname)
  ) {
    return false;
  }

  const labels = hostname.split(".");
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL_PATTERN.test(label));
}

function safeHttpsUrl(input: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input, base);
  } catch {
    fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자의 응답 주소를 확인하지 못했습니다.", 502);
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || !publicHostname(hostname)
  ) {
    fail("INVALID_PROVIDER_RESPONSE", "안전한 HTTPS 라이트닝 주소 제공자만 사용할 수 있습니다.", 502);
  }
  url.hostname = hostname;
  url.hash = "";
  return url;
}

function normalizeLightningAddress(value: unknown): { address: string; username: string; domain: string } {
  if (typeof value !== "string") fail("INVALID_ADDRESS", "라이트닝 주소를 확인하십시오.");

  const address = value.trim().toLowerCase();
  if (!address || address.length > MAX_LIGHTNING_ADDRESS_LENGTH || address.includes(" ")) {
    fail("INVALID_ADDRESS", "라이트닝 주소를 확인하십시오.");
  }

  const at = address.lastIndexOf("@");
  if (at <= 0 || at !== address.indexOf("@") || at === address.length - 1) {
    fail("INVALID_ADDRESS", "라이트닝 주소는 사용자명@도메인 형식이어야 합니다.");
  }

  const username = address.slice(0, at);
  const rawDomain = address.slice(at + 1);
  if (!USERNAME_PATTERN.test(username)) {
    fail("INVALID_ADDRESS", "라이트닝 주소의 사용자명 형식을 확인하십시오.");
  }

  let parsedDomain: URL;
  try {
    parsedDomain = new URL(`https://${rawDomain}/`);
  } catch {
    fail("INVALID_ADDRESS", "라이트닝 주소의 도메인을 확인하십시오.");
  }

  if (parsedDomain.port || parsedDomain.pathname !== "/" || parsedDomain.search || parsedDomain.hash) {
    fail("INVALID_ADDRESS", "라이트닝 주소의 도메인을 확인하십시오.");
  }
  const domain = parsedDomain.hostname.toLowerCase();
  if (!publicHostname(domain)) {
    fail("INVALID_ADDRESS", "공개 HTTPS 도메인의 라이트닝 주소만 사용할 수 있습니다.");
  }

  return { address: `${username}@${domain}`, username, domain };
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

function mandatoryPayerData(discovery: Record<string, unknown>): string[] {
  if (!isRecord(discovery.payerData)) return [];
  return Object.entries(discovery.payerData)
    .filter(([, config]) => isRecord(config) && config.mandatory === true)
    .map(([key]) => PAYER_DATA_LABELS[key] ?? key)
    .slice(0, 8);
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    fail("INVALID_REQUEST", "요청 내용이 너무 큽니다.", 413);
  }

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
        fail("INVALID_REQUEST", "요청 내용이 너무 큽니다.", 413);
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
    fail("INVALID_REQUEST", "요청 내용을 확인하지 못했습니다.");
  }
}

async function fetchJson(url: URL, timeoutMs: number): Promise<unknown> {
  let current = safeHttpsUrl(url);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
        fail("PROVIDER_TIMEOUT", "라이트닝 주소 제공자의 응답 시간이 초과되었습니다.", 504);
      }
      fail("PROVIDER_UNAVAILABLE", "라이트닝 주소 제공자에 연결하지 못했습니다.", 502);
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirectCount >= MAX_REDIRECTS) {
        fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자의 이동 경로를 확인하지 못했습니다.", 502);
      }
      current = safeHttpsUrl(location, current);
      continue;
    }

    if (!response.ok) {
      fail(
        response.status === 404 ? "ADDRESS_NOT_FOUND" : "PROVIDER_UNAVAILABLE",
        response.status === 404
          ? "이 라이트닝 주소를 찾지 못했습니다."
          : "라이트닝 주소 제공자가 요청을 처리하지 못했습니다.",
        response.status === 404 ? 404 : 502,
      );
    }

    const text = await response.text();
    if (!text || text.length > MAX_JSON_BYTES) {
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자의 응답 형식을 확인하지 못했습니다.", 502);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
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

export async function handleLightningAddressRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "POST 요청만 사용할 수 있습니다." }, 405);
  }

  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      fail("INVALID_REQUEST", "JSON 요청만 사용할 수 있습니다.");
    }

    const body = await readLimitedJson(request);
    if (!isRecord(body)) fail("INVALID_REQUEST", "요청 내용을 확인하지 못했습니다.");

    const { address, username, domain } = normalizeLightningAddress(body.address);
    const amountSats = parseAmountSats(body.amountSats);
    const amountMsat = amountSats * 1_000;

    const discoveryUrl = safeHttpsUrl(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`);
    const discovery = await fetchJson(discoveryUrl, DISCOVERY_TIMEOUT_MS);
    if (!isRecord(discovery)) {
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 주소 제공자의 응답을 확인하지 못했습니다.", 502);
    }
    if (discovery.status === "ERROR") {
      fail("ADDRESS_REJECTED", providerReason(discovery.reason, "이 라이트닝 주소가 요청을 거절했습니다."), 422);
    }
    if (discovery.tag !== "payRequest") {
      fail("UNSUPPORTED_ADDRESS", "이 주소는 LNURL-pay 라이트닝 주소가 아닙니다.", 422);
    }

    const requiredPayerData = mandatoryPayerData(discovery);
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

    const callbackUrl = safeHttpsUrl(discovery.callback);
    callbackUrl.searchParams.set("amount", String(amountMsat));
    const invoiceResponse = await fetchJson(callbackUrl, INVOICE_TIMEOUT_MS);
    if (!isRecord(invoiceResponse)) {
      fail("INVALID_PROVIDER_RESPONSE", "라이트닝 인보이스 응답을 확인하지 못했습니다.", 502);
    }
    if (invoiceResponse.status === "ERROR") {
      fail("INVOICE_REJECTED", providerReason(invoiceResponse.reason, "지갑 서비스가 인보이스 발급을 거절했습니다."), 422);
    }

    const invoice = invoiceResponse.pr;
    if (
      typeof invoice !== "string"
      || invoice.length < 20
      || invoice.length > MAX_INVOICE_LENGTH
      || /\s/u.test(invoice)
      || !invoice.toLowerCase().startsWith("lnbc")
    ) {
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
    return json({ ok: false, code: "INTERNAL_ERROR", message: "라이트닝 결제 요청을 만들지 못했습니다." }, 500);
  }
}
