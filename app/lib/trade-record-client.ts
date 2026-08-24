import {
  canonicalizeTradeRecordApiSuccess,
  isTradeRecordId,
  type TradeRecordApiError,
  type TradeRecordApiSuccess,
  type TradeRecordDraft,
// @ts-expect-error -- Node 22's native TypeScript test runner requires the explicit extension; this project emits no JS through tsc.
} from "./trade-record.ts";

const MAX_RESPONSE_BYTES = 16_384;
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
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("거래 기록 서버 응답이 너무 큽니다.");
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

/** Creates a signed record without placing its signature in the share URL. */
export async function createTradeRecord(
  draft: TradeRecordDraft,
  options: Readonly<{ endpoint?: string; signal?: AbortSignal }> = {},
): Promise<TradeRecordApiSuccess> {
  const response = await fetch(options.endpoint ?? "/api/trade-record", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(draft),
    signal: options.signal,
  });
  const value = await readBoundedResponse(response);
  if (!response.ok) throw apiError(value, response.status);
  return canonicalizeTradeRecordApiSuccess(value);
}

export async function fetchTradeRecord(
  id: string,
  options: Readonly<{ endpointBase?: string; retryNotFound?: boolean; signal?: AbortSignal }> = {},
): Promise<TradeRecordApiSuccess> {
  if (!isTradeRecordId(id)) throw new TypeError("거래 기록 식별자를 확인해 주세요.");
  const endpointBase = options.endpointBase ?? "/api/trade-record";
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${endpointBase.replace(/\/$/u, "")}/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: options.signal,
    });
    const value = await readBoundedResponse(response);
    if (response.ok) return canonicalizeTradeRecordApiSuccess(value);

    const retryDelay = options.retryNotFound && response.status === 404
      ? KV_PROPAGATION_RETRY_DELAYS_MS[attempt]
      : undefined;
    if (retryDelay === undefined) throw apiError(value, response.status);
    await waitForRetry(retryDelay, options.signal);
  }
}
