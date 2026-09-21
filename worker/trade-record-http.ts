const API_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export class TradeRecordRequestError extends Error {
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

export function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(API_HEADERS);
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { status, headers });
}

export function fail(code: string, message: string, status = 400, headers?: HeadersInit): never {
  throw new TradeRecordRequestError(code, message, status, headers);
}

export function methodNotAllowed(allow: string): Response {
  return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: `${allow} 요청만 사용할 수 있습니다.` }, 405, { Allow: allow });
}
