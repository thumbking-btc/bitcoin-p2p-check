export type BoundedBodyFailure = "invalid-content-length" | "invalid-json" | "invalid-media-type" | "invalid-utf8" | "too-large";

const DEFAULT_BODY_READ_DEADLINE_MS = 15_000;

export class BoundedBodyError extends Error {
  readonly failure: BoundedBodyFailure;

  constructor(failure: BoundedBodyFailure) {
    super(failure);
    this.name = "BoundedBodyError";
    this.failure = failure;
  }
}

export function isJsonMediaType(value: string | null): boolean {
  if (value === null) return false;
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

export function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body || body.locked) return;
  try {
    void body.cancel("bounded body rejected").catch(() => {
      // Preserve the validation failure when the producer cannot be cancelled.
    });
  } catch {
    // ReadableStream.cancel can also throw synchronously for a hostile stream.
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("bounded body read aborted", "AbortError");
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: string): void {
  try {
    void reader.cancel(reason).catch(() => {
      // Cancellation is best effort and must not replace the body failure.
    });
  } catch {
    // A hostile reader can throw synchronously while cancellation is requested.
  }
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) throw abortReason(signal);

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new DOMException("bounded body read deadline exceeded", "TimeoutError");

  let handleAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DOMException("bounded body read deadline exceeded", "TimeoutError"));
    }, remainingMs);
    if (signal) {
      handleAbort = () => reject(abortReason(signal));
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) handleAbort();
    }
  });

  try {
    return await Promise.race([reader.read(), interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && handleAbort) signal.removeEventListener("abort", handleAbort);
  }
}

function declaredLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value.trim())) {
    throw new BoundedBodyError("invalid-content-length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BoundedBodyError("invalid-content-length");
  return parsed;
}

export async function readBoundedBytes(
  message: Pick<Request, "body" | "headers"> | Pick<Response, "body" | "headers">,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let declared: number | null;
  try {
    declared = declaredLength(message.headers);
  } catch (error) {
    cancelBody(message.body);
    throw error;
  }
  if (declared !== null && declared > maximumBytes) {
    cancelBody(message.body);
    throw new BoundedBodyError("too-large");
  }
  if (!message.body) return new Uint8Array();

  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const deadlineAt = Date.now() + DEFAULT_BODY_READ_DEADLINE_MS;
  try {
    while (true) {
      const { done, value } = await readWithDeadline(reader, deadlineAt, signal);
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        cancelReader(reader, "bounded body exceeded");
        throw new BoundedBodyError("too-large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (!(error instanceof BoundedBodyError && error.failure === "too-large")) {
      cancelReader(reader, "bounded body read failed");
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An aborted read may remain pending when a hostile producer ignores cancel.
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedJson(
  message: Pick<Request, "body" | "headers"> | Pick<Response, "body" | "headers">,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!isJsonMediaType(message.headers.get("content-type"))) {
    cancelBody(message.body);
    throw new BoundedBodyError("invalid-media-type");
  }
  const bytes = await readBoundedBytes(message, maximumBytes, signal);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BoundedBodyError("invalid-utf8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoundedBodyError("invalid-json");
  }
}
