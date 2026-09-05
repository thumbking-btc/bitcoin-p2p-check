import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  BoundedBodyError,
  readBoundedJson,
} from "../worker/http-body.ts";
import {
  isSameOrSubdomain,
  normalizeLightningAddress,
  safePublicHttpsUrl,
} from "../worker/lightning-address-normalize.ts";
import { handleLightningAddressRequest } from "../worker/lightning-address.ts";
import { handleLightningPayRequest } from "../worker/lightning-pay.ts";
import {
  canonicalizeTradeRecordApiSuccess,
  getTradeRecordRetentionPolicy,
  TRADE_RECORD_SCHEMA_V1,
} from "../app/lib/trade-record.ts";
import { validateBolt11Invoice } from "../app/lib/bolt11-invoice.mjs";
import { handleTradeRecordRequest } from "../worker/trade-record.ts";
import { createBolt11Invoice } from "./bolt11-fixture.mjs";

class MemoryKv {
  values = new Map();
  deletes = [];
  puts = [];

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value, options) {
    this.values.set(key, value);
    this.puts.push({ key, value, options });
    assert.ok(options.expirationTtl > 0);
  }

  async delete(key) {
    this.deletes.push(key);
    this.values.delete(key);
  }
}

class OneShotFailingMirrorBarrierKv extends MemoryKv {
  flushes = 0;
  failNextRevocationCommit = true;

  async flushLegacyMirror() {
    this.flushes += 1;
    // The first call starts a clean revocation batch. Fail its commit barrier,
    // then allow the idempotent retry's start and commit barriers to succeed.
    if (this.failNextRevocationCommit && this.flushes === 2) {
      this.failNextRevocationCommit = false;
      throw new Error("simulated legacy mirror outage");
    }
  }
}

class AllowRateLimit {
  async limit() {
    return { success: true };
  }
}

class DenyRateLimit {
  calls = 0;

  async limit() {
    this.calls += 1;
    return { success: false };
  }
}

async function settleWithin(promise, timeoutMs = 500) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`operation did not settle within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function capability() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function draft() {
  return {
    condition: {
      role: "buyer",
      amountBasis: "krw",
      bitcoinDisplayUnit: "sats",
      paymentKrw: 1_000_000,
      sats: 1_000_000,
      referencePriceKrw: 100_000_000,
      marketObservedAt: new Date().toISOString(),
      koreaPremiumRatio: null,
      sellerPremiumBps: 0,
      fundingSource: null,
    },
    payment: null,
  };
}

async function signingFixture(records = new MemoryKv()) {
  const kid = "trade-record-security-test";
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  privateJwk.kid = kid;
  publicJwk.kid = kid;
  const environment = {
    DEPLOYMENT_ENV: "production",
    TRADE_RECORDS_ENABLED: true,
    TRADE_RECORDS: records,
    TRADE_RECORD_CREATE_RATE_LIMITER: new AllowRateLimit(),
    TRADE_RECORD_READ_RATE_LIMITER: new AllowRateLimit(),
    TRADE_RECORD_SIGNING_KEY: JSON.stringify(privateJwk),
  };
  const options = {
    allowLegacyKv: true,
    publicKeys: { [kid]: publicJwk },
    fetcher: async () => Response.json([{
      market: "KRW-BTC",
      trade_price: 100_000_000,
      trade_timestamp: Date.now(),
    }]),
  };
  return { environment, options, records };
}

function createRequest(body, token, lifecycle = "pending") {
  return new Request("https://records.example/api/trade-record", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "CF-Connecting-IP": "203.0.113.9",
      "Content-Type": "application/json; charset=utf-8",
      "Idempotency-Key": token,
      "X-Trade-Record-Lifecycle": lifecycle,
    },
    body: JSON.stringify(body),
  });
}

const LNURL_METADATA = JSON.stringify([
  ["text/plain", "P2P 거래 대금"],
  ["text/identifier", "seller@wallet.example.com"],
]);
const LNURL_METADATA_HASH = sha256(new TextEncoder().encode(LNURL_METADATA));

function createLnurlInvoice(overrides = {}) {
  return createBolt11Invoice({
    amountSats: 1_000,
    descriptionHash: LNURL_METADATA_HASH,
    ...overrides,
  });
}

const LIGHTNING_INVOICE = createLnurlInvoice();

function lightningAddressRequest() {
  return new Request("https://app.example/api/market?receive=lightning-address", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.10",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address: "seller@wallet.example.com", amountSats: 1_000 }),
  });
}

function lightningDiscoveryResponse(overrides = {}) {
  return Response.json({
    tag: "payRequest",
    callback: "https://wallet.example.com/lnurl/callback",
    minSendable: 1_000,
    maxSendable: 10_000_000,
    metadata: LNURL_METADATA,
    ...overrides,
  });
}

const RAW_LNURL = bech32.encode(
  "lnurl",
  bech32.toWords(new TextEncoder().encode("https://wallet.example.com/lnurl/discovery")),
  false,
);

function rawLnurlRequest() {
  return new Request("https://app.example/api/market?receive=lightning-pay", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.11",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source: RAW_LNURL, amountSats: 1_000 }),
  });
}

function lightningRedirectFixture({ discoveryRedirects = 0, callbackRedirects = 0 } = {}) {
  let phase = "discovery";
  let discoveryCalls = 0;
  let callbackCalls = 0;
  const urls = [];
  const signals = [];
  return {
    get discoveryCalls() { return discoveryCalls; },
    get callbackCalls() { return callbackCalls; },
    urls,
    signals,
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      assert.equal(url.protocol, "https:");
      assert.equal(url.hostname, "wallet.example.com");
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal instanceof AbortSignal);
      signals.push(init.signal);

      if (phase === "discovery") {
        discoveryCalls += 1;
        if (discoveryCalls <= discoveryRedirects) {
          return new Response(null, {
            status: 302,
            headers: { Location: "/.well-known/lnurlp/seller" },
          });
        }
        phase = "callback";
        return lightningDiscoveryResponse();
      }

      callbackCalls += 1;
      assert.equal(url.searchParams.get("amount"), "1000000");
      if (callbackCalls <= callbackRedirects) {
        return new Response(null, {
          status: 307,
          headers: { Location: "/lnurl/callback?amount=1000000" },
        });
      }
      return Response.json({ pr: LIGHTNING_INVOICE });
    },
  };
}

test("bounded JSON reading prechecks length, enforces streamed bytes, cancels, and requires exact media type", async () => {
  for (const scenario of ["declared", "streamed", "media"]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"too long"}'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = new Headers({ "Content-Type": scenario === "media" ? "application/jsonp" : "application/json" });
    if (scenario === "declared") headers.set("Content-Length", "1000");
    const response = new Response(body, { headers });
    await assert.rejects(
      readBoundedJson(response, scenario === "streamed" ? 4 : 100),
      (error) => error instanceof BoundedBodyError
        && error.failure === (scenario === "media" ? "invalid-media-type" : "too-large"),
    );
    assert.equal(cancelled, true);
  }
});

test("bounded body reads abort without awaiting hostile pulls or cancellation", async () => {
  let markPullStarted;
  const pullStarted = new Promise((resolve) => {
    markPullStarted = resolve;
  });
  let cancelled = false;
  const body = new ReadableStream({
    pull() {
      markPullStarted();
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  const controller = new AbortController();
  const pendingRead = readBoundedJson(new Response(body, {
    headers: { "Content-Type": "application/json" },
  }), 100, controller.signal);

  await settleWithin(pullStarted);
  controller.abort(new DOMException("body deadline exceeded", "TimeoutError"));
  await assert.rejects(
    settleWithin(pendingRead),
    (error) => error instanceof DOMException && error.name === "TimeoutError",
  );
  assert.equal(cancelled, true);
});

test("bounded body cancellation observes producer rejection without replacing validation", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
      return Promise.reject(new Error("producer cancellation failed"));
    },
  });
  const response = new Response(body, { headers: { "Content-Type": "text/plain" } });

  await assert.rejects(
    settleWithin(readBoundedJson(response, 100)),
    (error) => error instanceof BoundedBodyError && error.failure === "invalid-media-type",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("Lightning address canonicalization rejects Unicode, local names, ports, and unrelated hosts", () => {
  assert.deepEqual(normalizeLightningAddress("Seller@Wallet.Example.COM"), {
    address: "seller@wallet.example.com",
    username: "seller",
    domain: "wallet.example.com",
  });
  for (const invalid of [
    " seller@example.com",
    "seller@localhost",
    "seller@wallet.local",
    "seller@한글.example.com",
    "seller@example.com:443",
    "seller@127.0.0.1",
  ]) {
    assert.throws(() => normalizeLightningAddress(invalid));
  }
  assert.throws(() => safePublicHttpsUrl("https://user:pass@example.com/path"));
  assert.equal(isSameOrSubdomain("pay.wallet.example.com", "wallet.example.com"), true);
  assert.equal(isSameOrSubdomain("wallet.example.net", "wallet.example.com"), false);
});

test("Lightning upstreams fail closed without a limiter and reject non-JSON or cross-host responses", async () => {
  const request = () => new Request("https://app.example/api/market?receive=lightning-address", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.10",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address: "seller@wallet.example.com", amountSats: 1_000 }),
  });
  const unavailable = await handleLightningAddressRequest(request());
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "RATE_LIMIT_UNAVAILABLE");

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("{}", { headers: { "Content-Type": "text/plain" } });
    const wrongMedia = await handleLightningAddressRequest(request(), {
      LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
    });
    assert.equal(wrongMedia.status, 502);
    assert.equal((await wrongMedia.json()).code, "INVALID_PROVIDER_RESPONSE");

    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { Location: "https://attacker.example.net/pay" } });
    };
    const unrelated = await handleLightningAddressRequest(request(), {
      LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
    });
    assert.equal(unrelated.status, 502);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Lightning redirect validation cancels hostile bodies before rejecting location or host", async (context) => {
  const handlers = [
    {
      name: "address",
      request: lightningAddressRequest,
      handle: (request, environment) => handleLightningAddressRequest(request, environment),
    },
    {
      name: "raw LNURL",
      request: rawLnurlRequest,
      handle: (request, environment) => handleLightningPayRequest(request, environment),
    },
  ];
  const scenarios = [
    { name: "missing Location", headers: {}, expectedCalls: 1 },
    { name: "unrelated host", headers: { Location: "https://attacker.example.net/pay" }, expectedCalls: 1 },
    { name: "redirect limit", headers: { Location: "/another-hop" }, expectedCalls: 3 },
  ];

  for (const handler of handlers) {
    for (const scenario of scenarios) {
      await context.test(`${handler.name}: ${scenario.name}`, async () => {
        const originalFetch = globalThis.fetch;
        let cancellations = 0;
        let calls = 0;
        try {
          globalThis.fetch = async () => {
            calls += 1;
            const body = new ReadableStream({
              start(streamController) {
                streamController.enqueue(new TextEncoder().encode("redirect body must be ignored"));
              },
              cancel() {
                cancellations += 1;
                return new Promise(() => {});
              },
            });
            return new Response(body, { status: 302, headers: scenario.headers });
          };

          const response = await settleWithin(handler.handle(handler.request(), {
            LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
          }));
          assert.equal(response.status, 502);
          assert.equal((await response.json()).code, "INVALID_PROVIDER_RESPONSE");
          assert.equal(calls, scenario.expectedCalls);
          assert.equal(cancellations, scenario.expectedCalls);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  }
});

test("Lightning discovery and callback each accept exactly 0, 1, or 2 same-host redirects", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const redirectPhase of ["discovery", "callback"]) {
      for (const redirectCount of [0, 1, 2]) {
        const fixture = lightningRedirectFixture({
          discoveryRedirects: redirectPhase === "discovery" ? redirectCount : 0,
          callbackRedirects: redirectPhase === "callback" ? redirectCount : 0,
        });
        globalThis.fetch = fixture.fetcher;
        const response = await handleLightningAddressRequest(lightningAddressRequest(), {
          LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
        });
        assert.equal(response.status, 200, `${redirectPhase} must accept ${redirectCount} redirects`);
        const result = await response.json();
        assert.equal(result.ok, true);
        assert.equal(result.invoice, LIGHTNING_INVOICE);
        assert.equal(fixture.discoveryCalls, 1 + (redirectPhase === "discovery" ? redirectCount : 0));
        assert.equal(fixture.callbackCalls, 1 + (redirectPhase === "callback" ? redirectCount : 0));
        assert.equal(fixture.urls.length, 2 + redirectCount);
        assert.ok(fixture.signals.every((signal) => signal === fixture.signals[0]));
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Lightning discovery and callback reject a redirect loop beyond 2 hops", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const redirectPhase of ["discovery", "callback"]) {
      const fixture = lightningRedirectFixture({
        discoveryRedirects: redirectPhase === "discovery" ? 3 : 0,
        callbackRedirects: redirectPhase === "callback" ? 3 : 0,
      });
      globalThis.fetch = fixture.fetcher;
      const response = await handleLightningAddressRequest(lightningAddressRequest(), {
        LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).code, "INVALID_PROVIDER_RESPONSE");
      assert.equal(fixture.discoveryCalls, redirectPhase === "discovery" ? 3 : 1);
      assert.equal(fixture.callbackCalls, redirectPhase === "callback" ? 3 : 0);
      assert.equal(fixture.urls.length, redirectPhase === "discovery" ? 3 : 4);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Lightning discovery and callback map upstream 429 and timeout aborts to closed failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  try {
    for (const failurePhase of ["discovery", "callback"]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (failurePhase === "discovery" || calls === 2) {
          return Response.json({ status: "ERROR", reason: "rate limited" }, { status: 429 });
        }
        return lightningDiscoveryResponse();
      };
      const response = await handleLightningAddressRequest(lightningAddressRequest(), {
        LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).code, "PROVIDER_UNAVAILABLE");
      assert.equal(calls, failurePhase === "discovery" ? 1 : 2);
    }

    for (const failurePhase of ["discovery", "callback"]) {
      const timeoutDurations = [];
      const timeoutControllers = [];
      AbortSignal.timeout = (duration) => {
        timeoutDurations.push(duration);
        const controller = new AbortController();
        timeoutControllers.push(controller);
        return controller.signal;
      };
      let calls = 0;
      let markFetchStarted;
      const fetchStarted = new Promise((resolve) => {
        markFetchStarted = resolve;
      });
      globalThis.fetch = async (_input, init) => {
        calls += 1;
        if (failurePhase === "callback" && calls === 1) return lightningDiscoveryResponse();
        const signal = init?.signal;
        markFetchStarted();
        return await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };

      const pendingResponse = handleLightningAddressRequest(lightningAddressRequest(), {
        LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
      });
      await fetchStarted;
      const activeController = timeoutControllers.at(-1);
      assert.equal(activeController.signal.aborted, false);
      activeController.abort(new DOMException("provider deadline exceeded", "TimeoutError"));
      const response = await pendingResponse;
      assert.equal(activeController.signal.aborted, true);
      assert.equal(response.status, 504);
      const body = await response.json();
      assert.equal(body.code, "PROVIDER_TIMEOUT");
      assert.equal(body.issuanceStatus, failurePhase === "callback" ? "unknown" : "not-issued");
      assert.deepEqual(timeoutDurations, [12_000]);
      assert.equal(calls, failurePhase === "discovery" ? 1 : 2);
    }
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("raw LNURL completes discovery and callback with one shared provider deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const timeoutDurations = [];
  const signals = [];
  let calls = 0;
  try {
    AbortSignal.timeout = (duration) => {
      timeoutDurations.push(duration);
      return new AbortController().signal;
    };
    globalThis.fetch = async (input, init) => {
      calls += 1;
      const url = new URL(String(input));
      signals.push(init?.signal);
      assert.equal(init?.redirect, "manual");
      if (calls === 1) {
        assert.equal(url.toString(), "https://wallet.example.com/lnurl/discovery");
        return lightningDiscoveryResponse({
          payerData: { name: { mandatory: false } },
        });
      }
      assert.equal(calls, 2);
      assert.equal(url.toString(), "https://wallet.example.com/lnurl/callback?amount=1000000");
      return Response.json({ pr: LIGHTNING_INVOICE });
    };

    const response = await handleLightningPayRequest(rawLnurlRequest(), {
      LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      amountSats: 1_000,
      invoice: LIGHTNING_INVOICE,
      normalizedSource: RAW_LNURL,
      sourceType: "lnurl",
    });
    assert.equal(calls, 2);
    assert.deepEqual(timeoutDurations, [12_000]);
    assert.ok(signals[0] instanceof AbortSignal);
    assert.equal(signals[1], signals[0]);
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("direct BOLT11 validation still accepts a signed d-only invoice without LNURL metadata", () => {
  const invoice = createBolt11Invoice({ amountSats: 1_000 });
  const validated = validateBolt11Invoice(invoice, {
    expectedSats: 1_000n,
    minimumRemainingSeconds: 120,
  });
  assert.equal(validated.canonicalInvoice, invoice);
});

test("Lightning address and raw LNURL verify exact metadata bytes whenever the signed invoice uses h", async (context) => {
  const expandedMetadata = JSON.stringify([
    ["text/plain", "P2P 거래 대금", { displayHint: "compact" }],
    ["application/vnd.wallet.example+json", { feature: true }, 42],
  ]);
  const equivalentSpacedMetadata = `[
    ["text/plain", "P2P 거래 대금"],
    ["text/identifier", "seller@wallet.example.com"]
  ]`;
  const scenarios = [
    {
      name: "matching metadata hash",
      metadata: LNURL_METADATA,
      invoice: LIGHTNING_INVOICE,
      status: 200,
    },
    {
      name: "future metadata entry with arbitrary JSON values",
      metadata: expandedMetadata,
      invoice: createLnurlInvoice({
        descriptionHash: sha256(new TextEncoder().encode(expandedMetadata)),
      }),
      status: 200,
    },
    {
      name: "current LUD-06 d-only invoice",
      metadata: LNURL_METADATA,
      invoice: createBolt11Invoice({ amountSats: 1_000 }),
      status: 200,
    },
    {
      name: "wrong metadata hash",
      metadata: LNURL_METADATA,
      invoice: createLnurlInvoice({ descriptionHash: new Uint8Array(32).fill(0x44) }),
      status: 502,
    },
    {
      name: "equivalent JSON with different raw bytes",
      metadata: equivalentSpacedMetadata,
      invoice: LIGHTNING_INVOICE,
      status: 502,
    },
    {
      name: "duplicate h tags",
      metadata: LNURL_METADATA,
      invoice: createLnurlInvoice({ duplicateDescriptionHash: true }),
      status: 502,
    },
  ];
  const handlers = [
    {
      name: "address",
      request: lightningAddressRequest,
      handle: (request, environment) => handleLightningAddressRequest(request, environment),
    },
    {
      name: "raw LNURL",
      request: rawLnurlRequest,
      handle: (request, environment) => handleLightningPayRequest(request, environment),
    },
  ];

  for (const handler of handlers) {
    for (const scenario of scenarios) {
      await context.test(`${handler.name}: ${scenario.name}`, async () => {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        try {
          globalThis.fetch = async () => {
            calls += 1;
            return calls === 1
              ? lightningDiscoveryResponse({ metadata: scenario.metadata })
              : Response.json({ pr: scenario.invoice });
          };
          const response = await handler.handle(handler.request(), {
            LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
          });
          assert.equal(response.status, scenario.status);
          if (scenario.status === 502) {
            assert.equal((await response.json()).code, "INVALID_PROVIDER_RESPONSE");
          }
          assert.equal(calls, 2);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  }
});

test("Lightning address and raw LNURL reject invalid metadata or mandatory payer data before callback", async (context) => {
  const validDiscovery = {
    tag: "payRequest",
    callback: "https://wallet.example.com/lnurl/callback",
    minSendable: 1_000,
    maxSendable: 10_000_000,
    metadata: JSON.stringify([["text/plain", "P2P 거래 대금"]]),
  };
  const scenarios = [
    {
      name: "missing metadata",
      discovery: { ...validDiscovery, metadata: undefined },
      status: 502,
      code: "INVALID_PROVIDER_RESPONSE",
    },
    {
      name: "malformed metadata",
      discovery: { ...validDiscovery, metadata: "{" },
      status: 502,
      code: "INVALID_PROVIDER_RESPONSE",
    },
    {
      name: "metadata without text/plain",
      discovery: { ...validDiscovery, metadata: JSON.stringify([["image/png;base64", "AA=="]]) },
      status: 502,
      code: "INVALID_PROVIDER_RESPONSE",
    },
    {
      name: "duplicate text/plain metadata",
      discovery: {
        ...validDiscovery,
        metadata: JSON.stringify([["text/plain", "first"], ["text/plain", "second"]]),
      },
      status: 502,
      code: "INVALID_PROVIDER_RESPONSE",
    },
    {
      name: "mandatory payer data",
      discovery: { ...validDiscovery, payerData: { name: { mandatory: true } } },
      status: 422,
      code: "PAYER_DATA_REQUIRED",
    },
  ];
  const handlers = [
    {
      name: "address",
      request: lightningAddressRequest,
      handle: (request, environment) => handleLightningAddressRequest(request, environment),
    },
    {
      name: "raw LNURL",
      request: rawLnurlRequest,
      handle: (request, environment) => handleLightningPayRequest(request, environment),
    },
  ];

  for (const handler of handlers) {
    for (const scenario of scenarios) {
      await context.test(`${handler.name}: ${scenario.name}`, async () => {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        try {
          globalThis.fetch = async () => {
            calls += 1;
            return Response.json(scenario.discovery);
          };
          const response = await handler.handle(handler.request(), {
            LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
          });
          assert.equal(response.status, scenario.status);
          assert.equal((await response.json()).code, scenario.code);
          assert.equal(calls, 1, "validation must reject before the callback request");
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  }
});

test("Lightning address and raw LNURL reject wrong amount, network, signature, or expiry", async (context) => {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const invalidInvoices = [
    { name: "wrong amount", invoice: createLnurlInvoice({ amountSats: 2_000, timestampSeconds: nowSeconds }) },
    { name: "wrong network", invoice: createLnurlInvoice({ timestampSeconds: nowSeconds, network: "tb" }) },
    { name: "expired", invoice: createLnurlInvoice({ timestampSeconds: nowSeconds - 600, expirySeconds: 60 }) },
    {
      name: "invalid signature",
      invoice: `${LIGHTNING_INVOICE.slice(0, -1)}${LIGHTNING_INVOICE.endsWith("q") ? "p" : "q"}`,
    },
  ];
  const handlers = [
    {
      name: "address",
      request: lightningAddressRequest,
      handle: (request, environment) => handleLightningAddressRequest(request, environment),
    },
    {
      name: "raw LNURL",
      request: rawLnurlRequest,
      handle: (request, environment) => handleLightningPayRequest(request, environment),
    },
  ];

  for (const handler of handlers) {
    for (const scenario of invalidInvoices) {
      await context.test(`${handler.name}: ${scenario.name}`, async () => {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        try {
          globalThis.fetch = async () => {
            calls += 1;
            return calls === 1
              ? lightningDiscoveryResponse()
              : Response.json({ pr: scenario.invoice });
          };
          const response = await handler.handle(handler.request(), {
            LIGHTNING_REQUEST_RATE_LIMITER: new AllowRateLimit(),
          });
          assert.equal(response.status, 502);
          assert.equal((await response.json()).code, "INVALID_PROVIDER_RESPONSE");
          assert.equal(calls, 2);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  }
});

test("pending records are idempotent, hidden until finalize, and revocable only by capability", async () => {
  const { environment, options, records } = await signingFixture();
  const token = capability();
  const body = draft();
  const createdResponse = await handleTradeRecordRequest(createRequest(body, token), environment, options);
  assert.equal(createdResponse.status, 201);
  const created = canonicalizeTradeRecordApiSuccess(await createdResponse.json());
  assert.equal(created.lifecycle, "pending");
  assert.equal(created.revokeToken, token);
  assert.equal([...records.values.values()].some((value) => value.includes(token)), false, "raw capability must never be stored");

  const publicUrl = `https://records.example/api/trade-record/${created.id}`;
  assert.equal((await handleTradeRecordRequest(new Request(publicUrl), environment, options)).status, 404);

  const retriedResponse = await handleTradeRecordRequest(createRequest(body, token), environment, options);
  assert.equal(retriedResponse.status, 200);
  const retried = canonicalizeTradeRecordApiSuccess(await retriedResponse.json());
  assert.equal(retried.id, created.id);
  assert.equal(retried.signature, created.signature);

  const wrongToken = capability();
  const unauthorized = await handleTradeRecordRequest(new Request(`${publicUrl}/finalize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${wrongToken}` },
  }), environment, options);
  assert.equal(unauthorized.status, 403);

  const finalizeRequest = () => new Request(`${publicUrl}/finalize`, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  const finalizedResponse = await handleTradeRecordRequest(finalizeRequest(), environment, options);
  assert.equal(finalizedResponse.status, 200);
  const finalized = canonicalizeTradeRecordApiSuccess(await finalizedResponse.json());
  assert.equal(finalized.lifecycle, "finalized");
  assert.equal((await handleTradeRecordRequest(new Request(publicUrl), environment, options)).status, 200);
  assert.equal((await handleTradeRecordRequest(finalizeRequest(), environment, options)).status, 200, "finalize is idempotent");

  const deleteRequest = () => new Request(publicUrl, {
    method: "DELETE",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  assert.equal((await handleTradeRecordRequest(deleteRequest(), environment, options)).status, 200);
  assert.equal((await handleTradeRecordRequest(deleteRequest(), environment, options)).status, 200, "revoke is idempotent");
  assert.equal((await handleTradeRecordRequest(new Request(publicUrl), environment, options)).status, 404);
  const tombstoneWrite = records.puts.find(({ key }) => key.startsWith("trade-record:v1:manage:"));
  assert.equal(
    tombstoneWrite?.options.expirationTtl,
    getTradeRecordRetentionPolicy(TRADE_RECORD_SCHEMA_V1).retentionSeconds,
  );
  assert.equal(records.deletes.length, 2, "an idempotent retry also cleans up any partially revoked record");
});

test("revoke returns retryable 503 until the legacy mirror barrier succeeds", async () => {
  const records = new OneShotFailingMirrorBarrierKv();
  const { environment, options } = await signingFixture(records);
  const token = capability();
  const createdResponse = await handleTradeRecordRequest(createRequest(draft(), token), environment, options);
  const created = canonicalizeTradeRecordApiSuccess(await createdResponse.json());
  const publicUrl = `https://records.example/api/trade-record/${created.id}`;
  const deleteRequest = () => new Request(publicUrl, {
    method: "DELETE",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });

  const first = await handleTradeRecordRequest(deleteRequest(), environment, options);
  assert.equal(first.status, 503);
  assert.equal(first.headers.get("retry-after"), "1");
  assert.equal((await first.json()).code, "STORAGE_UNAVAILABLE");
  assert.equal(records.deletes.length, 1);

  const retried = await handleTradeRecordRequest(deleteRequest(), environment, options);
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { ok: true, id: created.id, lifecycle: "revoked" });
  assert.equal(records.deletes.length, 2, "retry must issue the legacy record deletion again");
  assert.equal(
    records.puts.filter(({ key }) => key.startsWith("trade-record:v1:manage:")).length,
    2,
    "retry must also re-write the legacy revocation tombstone",
  );
  assert.equal(records.flushes, 4, "each attempt must bracket its own mirror batch");
});

test("legacy or direct-finalized record creation fails before anything is stored", async () => {
  const { environment, options, records } = await signingFixture();
  const body = JSON.stringify(draft());
  const legacy = await handleTradeRecordRequest(new Request("https://records.example/api/trade-record", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.11", "Content-Type": "application/json" },
    body,
  }), environment, options);
  assert.equal(legacy.status, 400);
  assert.equal((await legacy.json()).code, "CLIENT_UPGRADE_REQUIRED");
  assert.equal(records.values.size, 0);

  const finalized = await handleTradeRecordRequest(createRequest(draft(), capability(), "finalized"), environment, options);
  assert.equal(finalized.status, 400);
  assert.equal((await finalized.json()).code, "INVALID_LIFECYCLE");
  assert.equal(records.values.size, 0);

  const missingCapability = await handleTradeRecordRequest(new Request("https://records.example/api/trade-record", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.12",
      "Content-Type": "application/json",
      "X-Trade-Record-Lifecycle": "pending",
    },
    body,
  }), environment, options);
  assert.equal(missingCapability.status, 400);
  assert.equal((await missingCapability.json()).code, "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(records.values.size, 0);
});

test("preview/false environments fail closed before bindings and signed absolute expiry is enforced", async () => {
  let bindingAccessed = false;
  const preview = {
    DEPLOYMENT_ENV: "preview",
    TRADE_RECORDS_ENABLED: false,
    get TRADE_RECORDS() {
      bindingAccessed = true;
      throw new Error("must not access production storage");
    },
  };
  const id = "AAAAAAAAAAAAAAAA";
  const get = await handleTradeRecordRequest(new Request(`https://preview.example/api/trade-record/${id}`), preview);
  const post = await handleTradeRecordRequest(new Request("https://preview.example/api/trade-record", { method: "POST" }), preview);
  const remove = await handleTradeRecordRequest(new Request(`https://preview.example/api/trade-record/${id}`, { method: "DELETE" }), preview);
  assert.equal(get.status, 404);
  assert.equal(post.status, 503);
  assert.equal(remove.status, 503);
  assert.equal(bindingAccessed, false);

  const fixture = await signingFixture();
  const token = capability();
  const createdResponse = await handleTradeRecordRequest(
    createRequest(draft(), token),
    fixture.environment,
    fixture.options,
  );
  const pending = canonicalizeTradeRecordApiSuccess(await createdResponse.json());
  const finalizedResponse = await handleTradeRecordRequest(new Request(
    `https://records.example/api/trade-record/${pending.id}/finalize`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  ), fixture.environment, fixture.options);
  const created = canonicalizeTradeRecordApiSuccess(await finalizedResponse.json());
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse(created.record.expiresAt) + 1;
    const expired = await handleTradeRecordRequest(
      new Request(`https://records.example/api/trade-record/${created.id}`),
      fixture.environment,
      fixture.options,
    );
    assert.equal(expired.status, 404);
  } finally {
    Date.now = originalNow;
  }
});

test("unexpected record errors log a route class without the bearer pathname", async () => {
  const id = "AAAAAAAAAAAAAAAA";
  const logs = [];
  const originalError = console.error;
  console.error = (value) => logs.push(String(value));
  try {
    const response = await handleTradeRecordRequest(
      new Request(`https://records.example/api/trade-record/${id}`),
      {
        DEPLOYMENT_ENV: "production",
        TRADE_RECORDS_ENABLED: true,
        TRADE_RECORDS: {
          async get() { throw new Error("storage failed"); },
          async put() {},
          async delete() {},
        },
      },
      { allowLegacyKv: true },
    );
    assert.equal(response.status, 500);
  } finally {
    console.error = originalError;
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"route":"item"/u);
  assert.doesNotMatch(logs[0], new RegExp(id, "u"));
  assert.doesNotMatch(logs[0], /\/api\/trade-record/u);
});

test("trade-record rate limits run before selecting or activating a Durable Object", async (context) => {
  const highCardinalityIds = [
    "AAAAAAAAAAAAAAAA",
    "BBBBBBBBBBBBBBBB",
    "CCCCCCCCCCCCCCCC",
  ];
  for (const scenario of [
    {
      name: "create",
      limiterKey: "TRADE_RECORD_CREATE_RATE_LIMITER",
      requests: () => [new Request("https://records.example/api/trade-record", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.120",
          "Content-Type": "application/json",
          "Idempotency-Key": capability(),
          "X-Trade-Record-Lifecycle": "pending",
        },
        body: JSON.stringify(draft()),
      })],
    },
    {
      name: "read",
      limiterKey: "TRADE_RECORD_READ_RATE_LIMITER",
      requests: () => highCardinalityIds.map((id) => new Request(`https://records.example/api/trade-record/${id}`, {
        headers: { "CF-Connecting-IP": "203.0.113.121" },
      })),
    },
    {
      name: "finalize",
      limiterKey: "TRADE_RECORD_READ_RATE_LIMITER",
      requests: () => highCardinalityIds.map((id) => new Request(
        `https://records.example/api/trade-record/${id}/finalize`,
        {
          method: "POST",
          headers: { "CF-Connecting-IP": "203.0.113.122" },
        },
      )),
    },
    {
      name: "delete",
      limiterKey: "TRADE_RECORD_READ_RATE_LIMITER",
      requests: () => highCardinalityIds.map((id) => new Request(
        `https://records.example/api/trade-record/${id}`,
        {
          method: "DELETE",
          headers: { "CF-Connecting-IP": "203.0.113.123" },
        },
      )),
    },
  ]) {
    await context.test(scenario.name, async () => {
      let namespaceSelections = 0;
      let namespaceAccesses = 0;
      const limiter = new DenyRateLimit();
      const environment = {
        DEPLOYMENT_ENV: "production",
        TRADE_RECORDS_ENABLED: true,
        [scenario.limiterKey]: limiter,
      };
      const stateNamespace = {
        idFromName() {
          namespaceSelections += 1;
          throw new Error("Durable Object must not be selected after a rejected limit check.");
        },
        get() {
          namespaceAccesses += 1;
          throw new Error("Durable Object must not be accessed after a rejected limit check.");
        },
      };
      const requests = scenario.requests();
      for (const request of requests) {
        const response = await handleTradeRecordRequest(request, environment, { stateNamespace });
        assert.equal(response.status, 429);
        assert.equal((await response.json()).code, "RATE_LIMITED");
      }
      assert.equal(limiter.calls, requests.length);
      assert.equal(namespaceSelections, 0);
      assert.equal(namespaceAccesses, 0);
    });
  }
});

test("management requests reject hostile bodies and mismatched capabilities before selecting a Durable Object", async (context) => {
  const token = capability();
  const id = base64Url(sha256(new TextEncoder().encode(token))).slice(0, 16);
  const wrongToken = capability();
  const environment = {
    DEPLOYMENT_ENV: "production",
    TRADE_RECORDS_ENABLED: true,
    TRADE_RECORD_READ_RATE_LIMITER: new AllowRateLimit(),
  };

  for (const scenario of [
    { name: "finalize", method: "POST", suffix: "/finalize" },
    { name: "delete", method: "DELETE", suffix: "" },
  ]) {
    await context.test(scenario.name, async () => {
      let namespaceSelections = 0;
      const stateNamespace = {
        idFromName() {
          namespaceSelections += 1;
          throw new Error("Rejected management requests must not select a Durable Object.");
        },
        get() {
          throw new Error("Rejected management requests must not access a Durable Object.");
        },
      };
      const hostileBody = new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          return new Promise(() => {});
        },
      });
      const bodyResponse = await settleWithin(handleTradeRecordRequest(new Request(
        `https://records.example/api/trade-record/${id}${scenario.suffix}`,
        {
          method: scenario.method,
          headers: {
            Authorization: `Bearer ${token}`,
            "CF-Connecting-IP": "203.0.113.124",
          },
          body: hostileBody,
          duplex: "half",
        },
      ), environment, { stateNamespace }));
      assert.equal(bodyResponse.status, 400);
      assert.equal((await bodyResponse.json()).code, "INVALID_REQUEST");

      const capabilityResponse = await settleWithin(handleTradeRecordRequest(new Request(
        `https://records.example/api/trade-record/${id}${scenario.suffix}`,
        {
          method: scenario.method,
          headers: {
            Authorization: `Bearer ${wrongToken}`,
            "CF-Connecting-IP": "203.0.113.124",
          },
        },
      ), environment, { stateNamespace }));
      assert.equal(capabilityResponse.status, 403);
      assert.equal((await capabilityResponse.json()).code, "INVALID_CAPABILITY");
      assert.equal(namespaceSelections, 0);
    });
  }
});

test("invalid trade-record paths and methods fail before selecting a Durable Object", async (context) => {
  const scenarios = [
    ["collection method", new Request("https://records.example/api/trade-record", { method: "GET" }), 405],
    ["item method", new Request("https://records.example/api/trade-record/AAAAAAAAAAAAAAAA", { method: "PUT" }), 405],
    ["finalize method", new Request("https://records.example/api/trade-record/AAAAAAAAAAAAAAAA/finalize", { method: "DELETE" }), 405],
    ["nested path", new Request("https://records.example/api/trade-record/AAAAAAAAAAAAAAAA/extra"), 404],
    ["invalid id", new Request("https://records.example/api/trade-record/not-valid"), 404],
  ];

  for (const [name, request, expectedStatus] of scenarios) {
    await context.test(name, async () => {
      let namespaceSelections = 0;
      const environment = {
        DEPLOYMENT_ENV: "production",
        TRADE_RECORDS_ENABLED: true,
        TRADE_RECORD_CREATE_RATE_LIMITER: {
          async limit() { throw new Error("Invalid routes must not consume the create limiter."); },
        },
        TRADE_RECORD_READ_RATE_LIMITER: {
          async limit() { throw new Error("Invalid routes must not consume the item limiter."); },
        },
      };
      const stateNamespace = {
        idFromName() {
          namespaceSelections += 1;
          throw new Error("Invalid routes must not select a Durable Object.");
        },
        get() {
          throw new Error("Invalid routes must not access a Durable Object.");
        },
      };
      const response = await handleTradeRecordRequest(request, environment, { stateNamespace });
      assert.equal(response.status, expectedStatus);
      assert.equal(namespaceSelections, 0);
    });
  }
});

test("market source has bounded parsing, no module-global request promises, and create has a built-in deadline", async () => {
  const [market, client, marketModule] = await Promise.all([
    readFile(new URL("../worker/market.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-record-client.ts", import.meta.url), "utf8"),
    import("../worker/market.ts"),
  ]);
  assert.equal(typeof marketModule.handleMarketRequest, "function");
  assert.match(market, /readBoundedJson\(\s*response,\s*MAX_UPSTREAM_JSON_BYTES,\s*controller\.signal\s*\)/u);
  assert.doesNotMatch(market, /let\s+pending(?:Snapshot|Reference|Premium)/u);
  assert.doesNotMatch(market, /response\.json\(\)/u);
  assert.match(client, /DEFAULT_TRADE_RECORD_CREATE_TIMEOUT_MS\s*=\s*15_000/u);
  assert.match(client, /options\.timeoutMs\s*\?\?\s*DEFAULT_TRADE_RECORD_CREATE_TIMEOUT_MS/u);
});
