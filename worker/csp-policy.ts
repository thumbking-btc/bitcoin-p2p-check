import { readBoundedBytes } from "./http-body.ts";

const MAX_CSP_POLICY_BYTES = 16_384;

function cancelWithoutWaiting(body: ReadableStream<Uint8Array> | null, reason: string): void {
  if (!body || body.locked) return;
  try {
    void body.cancel(reason).catch(() => undefined);
  } catch {
    // Cleanup must never delay or replace the fail-closed static response.
  }
}

async function readCspPolicy(response: Response): Promise<string | null> {
  try {
    const bytes = await readBoundedBytes(response, MAX_CSP_POLICY_BYTES);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return null;
  }
}

export async function loadValidatedCspPolicy(
  fetchPolicy: () => Promise<Response>,
  discardedHtmlBody: ReadableStream<Uint8Array> | null,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchPolicy();
  } catch {
    cancelWithoutWaiting(discardedHtmlBody, "HTML response rejected because CSP policy fetch failed");
    return null;
  }
  if (!response.ok) {
    cancelWithoutWaiting(response.body, "invalid CSP policy response ignored");
    cancelWithoutWaiting(discardedHtmlBody, "HTML response rejected because CSP policy is unavailable");
    return null;
  }

  const policy = await readCspPolicy(response);
  if (!policy
    || policy.includes("unsafe-inline")
    || /[\r\n]/u.test(policy)
    || !/\bscript-src\b[^;]*'sha256-/u.test(policy)) {
    cancelWithoutWaiting(discardedHtmlBody, "HTML response rejected because CSP policy is invalid");
    return null;
  }
  return policy;
}
