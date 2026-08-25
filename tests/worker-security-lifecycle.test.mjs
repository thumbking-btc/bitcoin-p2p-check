import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
import {
  canonicalizeTradeRecordApiSuccess,
  getTradeRecordRetentionPolicy,
  TRADE_RECORD_SCHEMA_V1,
} from "../app/lib/trade-record.ts";
import { handleTradeRecordRequest } from "../worker/trade-record.ts";

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

class AllowRateLimit {
  async limit() {
    return { success: true };
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

async function signingFixture() {
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
  const records = new MemoryKv();
  const environment = {
    DEPLOYMENT_ENV: "production",
    TRADE_RECORDS_ENABLED: true,
    TRADE_RECORDS: records,
    TRADE_RECORD_CREATE_RATE_LIMITER: new AllowRateLimit(),
    TRADE_RECORD_SIGNING_KEY: JSON.stringify(privateJwk),
  };
  const options = {
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

const LIGHTNING_INVOICE = "lnbc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

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

function lightningDiscoveryResponse() {
  return Response.json({
    tag: "payRequest",
    callback: "https://wallet.example.com/lnurl/callback",
    minSendable: 1_000,
    maxSendable: 10_000_000,
  });
}

function lightningRedirectFixture({ discoveryRedirects = 0, callbackRedirects = 0 } = {}) {
  let phase = "discovery";
  let discoveryCalls = 0;
  let callbackCalls = 0;
  const urls = [];
  return {
    get discoveryCalls() { return discoveryCalls; },
    get callbackCalls() { return callbackCalls; },
    urls,
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      assert.equal(url.protocol, "https:");
      assert.equal(url.hostname, "wallet.example.com");
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal instanceof AbortSignal);

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
      assert.equal((await response.json()).code, "PROVIDER_TIMEOUT");
      assert.deepEqual(timeoutDurations, failurePhase === "discovery" ? [5_000] : [5_000, 7_000]);
      assert.equal(calls, failurePhase === "discovery" ? 1 : 2);
    }
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = originalFetch;
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
        TRADE_RECORDS: {
          async get() { throw new Error("storage failed"); },
          async put() {},
          async delete() {},
        },
      },
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

test("market source has bounded parsing, no module-global request promises, and create has a built-in deadline", async () => {
  const [market, client, marketModule] = await Promise.all([
    readFile(new URL("../worker/market.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-record-client.ts", import.meta.url), "utf8"),
    import("../worker/market.ts"),
  ]);
  assert.equal(typeof marketModule.handleMarketRequest, "function");
  assert.match(market, /readBoundedJson\(response, MAX_UPSTREAM_JSON_BYTES\)/u);
  assert.doesNotMatch(market, /let\s+pending(?:Snapshot|Reference|Premium)/u);
  assert.doesNotMatch(market, /response\.json\(\)/u);
  assert.match(client, /DEFAULT_TRADE_RECORD_CREATE_TIMEOUT_MS\s*=\s*15_000/u);
  assert.match(client, /options\.timeoutMs\s*\?\?\s*DEFAULT_TRADE_RECORD_CREATE_TIMEOUT_MS/u);
});
