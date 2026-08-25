export type BoundedBodyFailure = "invalid-content-length" | "invalid-json" | "invalid-media-type" | "invalid-utf8" | "too-large";

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

export async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body || body.locked) return;
  try {
    await body.cancel("bounded body rejected");
  } catch {
    // Preserve the validation failure when the producer cannot be cancelled.
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
): Promise<Uint8Array> {
  let declared: number | null;
  try {
    declared = declaredLength(message.headers);
  } catch (error) {
    await cancelBody(message.body);
    throw error;
  }
  if (declared !== null && declared > maximumBytes) {
    await cancelBody(message.body);
    throw new BoundedBodyError("too-large");
  }
  if (!message.body) return new Uint8Array();

  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        try {
          await reader.cancel("bounded body exceeded");
        } catch {
          // Preserve the size error when cancellation also fails.
        }
        throw new BoundedBodyError("too-large");
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
  return bytes;
}

export async function readBoundedJson(
  message: Pick<Request, "body" | "headers"> | Pick<Response, "body" | "headers">,
  maximumBytes: number,
): Promise<unknown> {
  if (!isJsonMediaType(message.headers.get("content-type"))) {
    await cancelBody(message.body);
    throw new BoundedBodyError("invalid-media-type");
  }
  const bytes = await readBoundedBytes(message, maximumBytes);
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
