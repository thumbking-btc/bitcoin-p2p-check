import {
  canonicalizeTradeRecordApiSuccess,
  canonicalizeTradeRecordRevokeSuccess,
  isTradeRecordId,
  TRADE_RECORD_REVOKE_TOKEN_PATTERN,
  type TradeRecordApiError,
  type TradeRecordApiSuccess,
  type TradeRecordDraft,
  type TradeRecordRevokeSuccess,
} from "./trade-record.ts";

const MAX_RESPONSE_BYTES = 16_384;
export const DEFAULT_TRADE_RECORD_CREATE_TIMEOUT_MS = 15_000;
const KV_PROPAGATION_RETRY_DELAYS_MS = Object.freeze([500, 1_000, 2_000, 4_000] as const);

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal ? abortReason(signal) : new DOMException("The operation was aborted.", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    try {
      await response.body?.cancel("non-JSON response rejected");
    } catch {
      // Preserve the media-type failure when cancellation also fails.
    }
    throw new Error("거래 기록 서버가 JSON 응답을 반환하지 않았습니다.");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && !/^(?:0|[1-9][0-9]*)$/u.test(contentLength.trim())) {
    try {
      await response.body?.cancel("invalid content length");
    } catch {
      // Preserve the header failure when cancellation also fails.
    }
    throw new Error("거래 기록 서버 응답 길이를 확인하지 못했습니다.");
  }
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > MAX_RESPONSE_BYTES)) {
    try {
      await response.body?.cancel("response too large");
    } catch {
      // Preserve the size failure when cancellation also fails.
    }
    throw new Error("거래 기록 서버 응답이 너무 큽니다.");
  }
  if (!response.body) throw new Error("거래 기록 서버 응답을 확인하지 못했습니다.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel("response too large");
        } catch {
          // The size violation remains the user-facing failure if cancellation also fails.
        }
        throw new Error("거래 기록 서버 응답이 너무 큽니다.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (received === 0) throw new Error("거래 기록 서버 응답을 확인하지 못했습니다.");
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("거래 기록 서버 응답의 문자 형식을 확인하지 못했습니다.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("거래 기록 서버가 올바른 JSON을 반환하지 않았습니다.");
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Generates a 256-bit capability. The caller should retain it until finalize or revoke succeeds. */
export function createTradeRecordRevokeToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function validRevokeToken(value: string): string {
  if (!TRADE_RECORD_REVOKE_TOKEN_PATTERN.test(value)) {
    throw new TypeError("거래 기록 관리 capability를 확인해 주세요.");
  }
  return value;
}

type RequestDeadline = Readonly<{
  cleanup: () => void;
  didTimeout: () => boolean;
  signal: AbortSignal;
}>;

function requestDeadline(externalSignal: AbortSignal | undefined, timeoutMs: number): RequestDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new TypeError("거래 기록 요청 제한 시간을 확인해 주세요.");
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(externalSignal ? abortReason(externalSignal) : undefined);
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Trade record request timed out.", "TimeoutError"));
  }, timeoutMs);
  return {
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onAbort);
    },
    didTimeout: () => timedOut,
    signal: controller.signal,
  };
}

async function timedJsonRequest(
  input: string,
  init: RequestInit,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Readonly<{ response: Response; value: unknown }>> {
  const deadline = requestDeadline(externalSignal, timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: deadline.signal });
    return { response, value: await readBoundedResponse(response) };
  } catch (error) {
    if (deadline.didTimeout()) {
      throw new TradeRecordApiRequestError("REQUEST_TIMEOUT", "거래 기록 서버 응답 시간이 초과되었습니다.", 0);
    }
    throw error;
  } finally {
    deadline.cleanup();
  }
}

export class TradeRecordApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "TradeRecordApiRequestError";
    this.code = code;
    this.status = status;
  }
}

export class TradeRecordNetworkError extends Error {
  constructor(cause: unknown) {
    super("거래 기록 서버에 연결하지 못했습니다.", { cause });
    this.name = "TradeRecordNetworkError";
  }
}

function apiError(value: unknown, status: number): TradeRecordApiRequestError {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const error = value as Partial<TradeRecordApiError>;
    if (
      error.ok === false
      && typeof error.code === "string"
      && error.code.length >= 1
      && error.code.length <= 64
      && typeof error.message === "string"
      && error.message.length <= 240
    ) {
      return new TradeRecordApiRequestError(error.code, error.message, status);
    }
  }
  return new TradeRecordApiRequestError("HTTP_ERROR", `거래 기록 요청을 처리하지 못했습니다. (HTTP ${status})`, status);
}

/** Creates a private, short-lived signed record that must be finalized after delivery. */
export async function createTradeRecord(
  draft: TradeRecordDraft,
  options: Readonly<{
    endpoint?: string;
    revokeToken?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }> = {},
): Promise<TradeRecordApiSuccess> {
  const revokeToken = validRevokeToken(options.revokeToken ?? createTradeRecordRevokeToken());
  const { response, value } = await timedJsonRequest(options.endpoint ?? "/api/trade-record", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": revokeToken,
      "X-Trade-Record-Lifecycle": "pending",
    },
    cache: "no-store",
    body: JSON.stringify(draft),
  }, options.signal, options.timeoutMs ?? DEFAULT_TRADE_RECORD_CREATE_TIMEOUT_MS);
  if (!response.ok) throw apiError(value, response.status);
  const result = canonicalizeTradeRecordApiSuccess(value);
  if (result.revokeToken !== revokeToken || result.lifecycle !== "pending") {
    throw new Error("거래 기록 서버의 관리 capability가 요청과 일치하지 않습니다.");
  }
  return result;
}

/** Creates a private, short-lived record that must be finalized before its public GET succeeds. */
export function createPendingTradeRecord(
  draft: TradeRecordDraft,
  options: Readonly<{ endpoint?: string; revokeToken?: string; signal?: AbortSignal; timeoutMs?: number }> = {},
): Promise<TradeRecordApiSuccess> {
  return createTradeRecord(draft, options);
}

export async function finalizeTradeRecord(
  id: string,
  revokeToken: string,
  options: Readonly<{ endpointBase?: string; signal?: AbortSignal; timeoutMs?: number }> = {},
): Promise<TradeRecordApiSuccess> {
  if (!isTradeRecordId(id)) throw new TypeError("거래 기록 식별자를 확인해 주세요.");
  const capability = validRevokeToken(revokeToken);
  const endpointBase = options.endpointBase ?? "/api/trade-record";
  const { response, value } = await timedJsonRequest(
    `${endpointBase.replace(/\/$/u, "")}/${encodeURIComponent(id)}/finalize`,
    {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${capability}` },
      cache: "no-store",
    },
    options.signal,
    options.timeoutMs ?? DEFAULT_TRADE_RECORD_CREATE_TIMEOUT_MS,
  );
  if (!response.ok) throw apiError(value, response.status);
  const result = canonicalizeTradeRecordApiSuccess(value);
  if (result.id !== id || result.lifecycle !== "finalized" || result.revokeToken !== capability) {
    throw new Error("거래 기록 확정 응답을 확인하지 못했습니다.");
  }
  return result;
}

export async function revokeTradeRecord(
  id: string,
  revokeToken: string,
  options: Readonly<{ endpointBase?: string; signal?: AbortSignal; timeoutMs?: number }> = {},
): Promise<TradeRecordRevokeSuccess> {
  if (!isTradeRecordId(id)) throw new TypeError("거래 기록 식별자를 확인해 주세요.");
  const capability = validRevokeToken(revokeToken);
  const endpointBase = options.endpointBase ?? "/api/trade-record";
  const { response, value } = await timedJsonRequest(
    `${endpointBase.replace(/\/$/u, "")}/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: { Accept: "application/json", Authorization: `Bearer ${capability}` },
      cache: "no-store",
    },
    options.signal,
    options.timeoutMs ?? DEFAULT_TRADE_RECORD_CREATE_TIMEOUT_MS,
  );
  if (!response.ok) throw apiError(value, response.status);
  const result = canonicalizeTradeRecordRevokeSuccess(value);
  if (result.id !== id) throw new Error("거래 기록 폐기 응답을 확인하지 못했습니다.");
  return result;
}

export async function fetchTradeRecord(
  id: string,
  options: Readonly<{ endpointBase?: string; retryNotFound?: boolean; signal?: AbortSignal }> = {},
): Promise<TradeRecordApiSuccess> {
  if (!isTradeRecordId(id)) throw new TypeError("거래 기록 식별자를 확인해 주세요.");
  const endpointBase = options.endpointBase ?? "/api/trade-record";
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${endpointBase.replace(/\/$/u, "")}/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new TradeRecordNetworkError(error);
    }
    const value = await readBoundedResponse(response);
    if (response.ok) return canonicalizeTradeRecordApiSuccess(value);

    const retryDelay = options.retryNotFound && response.status === 404
      ? KV_PROPAGATION_RETRY_DELAYS_MS[attempt]
      : undefined;
    if (retryDelay === undefined) throw apiError(value, response.status);
    await waitForRetry(retryDelay, options.signal);
  }
}
