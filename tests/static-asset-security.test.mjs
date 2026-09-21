import assert from "node:assert/strict";
import test from "node:test";

import { loadValidatedCspPolicy } from "../worker/csp-policy.ts";

async function settleWithin(promise, timeoutMs = 100) {
  const timeout = Symbol("timeout");
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timeout), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stalledCancellationBody(onCancel, chunks = []) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    cancel() {
      onCancel();
      return new Promise(() => {});
    },
  });
}

test("oversized streamed CSP policy fails closed without buffering or awaiting body cancellation", async () => {
  let htmlCancelled = false;
  let policyCancelled = false;
  const htmlBody = stalledCancellationBody(() => {
    htmlCancelled = true;
  });
  const policyBody = stalledCancellationBody(
    () => {
      policyCancelled = true;
    },
    [new Uint8Array(16_385)],
  );
  const result = await settleWithin(loadValidatedCspPolicy(
    async () => new Response(policyBody, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
    htmlBody,
  ));

  assert.equal(result, null, "stalled body cancellation must not block fail-closed policy validation");
  assert.equal(policyCancelled, true);
  assert.equal(htmlCancelled, true);
});

test("missing CSP policy cancels the discarded HTML and policy bodies without waiting", async () => {
  let htmlCancelled = false;
  let policyCancelled = false;
  const htmlBody = stalledCancellationBody(() => {
    htmlCancelled = true;
  });
  const result = await settleWithin(loadValidatedCspPolicy(
    async () => new Response(stalledCancellationBody(() => {
      policyCancelled = true;
    }), { status: 404 }),
    htmlBody,
  ));

  assert.equal(result, null, "stalled body cancellation must not block fail-closed policy validation");
  assert.equal(policyCancelled, true);
  assert.equal(htmlCancelled, true);
});
