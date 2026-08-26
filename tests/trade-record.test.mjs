import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createOnchainRequest } from "../app/lib/onchain-request.mjs";
import {
  canonicalTradeRecordJson,
  canonicalizeTradeRecord,
  canonicalizeTradeRecordApiSuccess,
  getTradeRecordRetentionPolicy,
  TRADE_RECORD_RETENTION_POLICIES,
  TRADE_RECORD_RETENTION_SECONDS,
  TRADE_RECORD_SCHEMA,
  TRADE_RECORD_SCHEMA_V1,
} from "../app/lib/trade-record.ts";
import {
  TRADE_RECORD_PUBLIC_KEYS,
  verifyTradeRecordSignature,
} from "../app/lib/trade-record-verification.ts";
import {
  fetchTradeRecord,
  isRetryableTradeRecordFetchError,
  isTerminalTradeRecordRevocationError,
  TradeRecordApiRequestError,
  TradeRecordNetworkError,
} from "../app/lib/trade-record-client.ts";
import { managementKey, sha256Base64Url } from "../worker/trade-record-lifecycle.ts";
import { handleTradeRecordRequest } from "../worker/trade-record.ts";

const ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

test("classifies only permanent revoke failures as terminal capability outcomes", () => {
  for (const error of [
    new TradeRecordApiRequestError("INVALID_CAPABILITY", "invalid", 401),
    new TradeRecordApiRequestError("INVALID_CAPABILITY", "invalid", 403),
    new TradeRecordApiRequestError("RECORD_NOT_FOUND", "missing", 404),
    new TradeRecordApiRequestError("RECORD_REVOKED", "revoked", 409),
  ]) {
    assert.equal(isTerminalTradeRecordRevocationError(error), true);
  }
  for (const error of [
    new TradeRecordApiRequestError("REQUEST_TIMEOUT", "timeout", 0),
    new TradeRecordApiRequestError("HTTP_ERROR", "conflict", 409),
    new TradeRecordApiRequestError("STORAGE_UNAVAILABLE", "unavailable", 503),
    new TradeRecordNetworkError(new TypeError("offline")),
    new Error("malformed response"),
  ]) {
    assert.equal(isTerminalTradeRecordRevocationError(error), false);
  }
});

class MemoryKv {
  values = new Map();
  puts = [];
  deletes = [];

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value, options) {
    this.values.set(key, value);
    this.puts.push({ key, value, options });
  }

  async delete(key) {
    this.values.delete(key);
    this.deletes.push(key);
  }
}

class MemoryRateLimit {
  calls = [];
  success = true;

  async limit(options) {
    this.calls.push(options);
    return { success: this.success };
  }
}

function upbitPriceFetcher(priceKrw = 100_000_000, tradeTimestamp = Date.now()) {
  return async (input, init) => {
    assert.equal(String(input), "https://api.upbit.com/v1/ticker?markets=KRW-BTC");
    assert.equal(init?.redirect, "manual");
    return Response.json([{
      market: "KRW-BTC",
      trade_price: priceKrw,
      trade_timestamp: tradeTimestamp,
    }]);
  };
}

async function signingEnvironment() {
  const kid = "trade-record-test-key-1";
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  privateJwk.kid = kid;
  publicJwk.kid = kid;
  publicJwk.key_ops = ["verify"];
  const records = new MemoryKv();
  const publicKeys = { [kid]: publicJwk };
  const rateLimiter = new MemoryRateLimit();
  const fetcher = upbitPriceFetcher();
  const environment = {
    DEPLOYMENT_ENV: "production",
    TRADE_RECORDS_ENABLED: true,
    TRADE_RECORDS: records,
    TRADE_RECORD_CREATE_RATE_LIMITER: rateLimiter,
    TRADE_RECORD_SIGNING_KEY: JSON.stringify(privateJwk),
  };
  return {
    environment,
    fetcher,
    handle: (request, environmentOverride = environment, optionsOverride = {}) => handleTradeRecordRequest(
      request,
      environmentOverride,
      { allowLegacyKv: true, publicKeys, fetcher, ...optionsOverride },
    ),
    publicKeys,
    rateLimiter,
    records,
  };
}

function validDraft(payment = null) {
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
      fundingSource: "근로소득",
    },
    payment,
  };
}

function createCapability() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function createRequest(draft, path = "/api/trade-record") {
  return new Request(`https://records.example${path}`, {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.10",
      "Content-Type": "application/json",
      "Idempotency-Key": createCapability(),
      "X-Trade-Record-Lifecycle": "pending",
      Accept: "application/json",
    },
    body: JSON.stringify(draft),
  });
}

async function assertStorageCorruptResponse(response) {
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, "STORAGE_CORRUPT");
}

function assertStorageUnchanged(records, expectedValues) {
  assert.deepEqual(records.values, expectedValues);
  assert.deepEqual(records.puts, []);
  assert.deepEqual(records.deletes, []);
}

async function finalizedManagedRecordFixture() {
  const fixture = await signingEnvironment();
  const create = createRequest(validDraft());
  const capability = create.headers.get("Idempotency-Key");
  const createdResponse = await fixture.handle(create);
  assert.equal(createdResponse.status, 201);
  const created = canonicalizeTradeRecordApiSuccess(await createdResponse.json());
  const recordUrl = `https://records.example/api/trade-record/${created.id}`;
  const finalized = await fixture.handle(new Request(`${recordUrl}/finalize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${capability}` },
  }));
  assert.equal(finalized.status, 200);
  return { ...fixture, capability, created, recordUrl };
}

test("pins the v1 retention policy and canonical signed representation", () => {
  const policy = getTradeRecordRetentionPolicy(TRADE_RECORD_SCHEMA_V1);
  assert.equal(TRADE_RECORD_SCHEMA, TRADE_RECORD_SCHEMA_V1);
  assert.equal(policy.schema, "bitcoin-p2p-trade-record/v1");
  assert.equal(policy.retentionSeconds, 15_552_000);
  assert.equal(TRADE_RECORD_RETENTION_SECONDS, policy.retentionSeconds);
  assert.equal(getTradeRecordRetentionPolicy("bitcoin-p2p-trade-record/v2"), null);
  assert.equal(Object.isFrozen(TRADE_RECORD_RETENTION_POLICIES), true);
  assert.equal(Object.isFrozen(policy), true);

  const v1Record = {
    schema: TRADE_RECORD_SCHEMA_V1,
    payment: null,
    expiresAt: "2026-06-30T00:00:00.000Z",
    condition: {
      fundingSource: null,
      sellerPremiumBps: 0,
      koreaPremiumRatio: null,
      marketObservedAt: "2026-01-01T00:00:00.000Z",
      referencePriceKrw: 100_000_000,
      sats: 1_000_000,
      paymentKrw: 1_000_000,
      bitcoinDisplayUnit: "sats",
      amountBasis: "krw",
      role: "buyer",
    },
    id: "AAAAAAAAAAAAAAAA",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const expectedCanonicalJson = [
    '{"schema":"bitcoin-p2p-trade-record/v1","id":"AAAAAAAAAAAAAAAA",',
    '"createdAt":"2026-01-01T00:00:00.000Z","expiresAt":"2026-06-30T00:00:00.000Z",',
    '"condition":{"role":"buyer","amountBasis":"krw","bitcoinDisplayUnit":"sats",',
    '"paymentKrw":1000000,"sats":1000000,"referencePriceKrw":100000000,',
    '"marketObservedAt":"2026-01-01T00:00:00.000Z","koreaPremiumRatio":null,',
    '"sellerPremiumBps":0,"fundingSource":null},"payment":null}',
  ].join("");
  assert.equal(canonicalTradeRecordJson(v1Record), expectedCanonicalJson);

  assert.throws(
    () => canonicalizeTradeRecord({ ...v1Record, expiresAt: "2026-06-30T00:00:01.000Z" }),
    (error) => error?.code === "INVALID_RECORD",
  );
  assert.throws(
    () => canonicalizeTradeRecord({ ...v1Record, schema: "bitcoin-p2p-trade-record/v2" }),
    (error) => error?.code === "INVALID_RECORD",
  );
});

test("creates privately, finalizes, fetches, and independently verifies a signed trade record", async () => {
  const { handle, publicKeys, records } = await signingEnvironment();
  const request = createRequest(validDraft());
  const capability = request.headers.get("Idempotency-Key");
  const createResponse = await handle(request);
  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.headers.get("cache-control"), "no-store");

  const created = canonicalizeTradeRecordApiSuccess(await createResponse.json());
  assert.match(created.id, /^[A-Za-z0-9_-]{16}$/u);
  assert.equal(created.id, created.record.id);
  assert.equal(created.verificationUrl, `https://records.example/verify/?id=${created.id}`);
  assert.equal(created.record.schema, TRADE_RECORD_SCHEMA_V1);
  assert.equal(
    Date.parse(created.record.expiresAt) - Date.parse(created.record.createdAt),
    getTradeRecordRetentionPolicy(created.record.schema).retentionSeconds * 1_000,
  );
  assert.equal(records.puts.length, 1);
  assert.equal(records.puts[0].options.expirationTtl, 15 * 60);

  const verified = await verifyTradeRecordSignature(created, { publicKeys });
  assert.equal(verified.status, "valid");
  assert.equal(verified.record.condition.fundingSource, "근로소득");
  assert.equal(verified.record.payment, null);

  const recordUrl = `https://records.example/api/trade-record/${created.id}`;
  const hiddenResponse = await handle(
    new Request(recordUrl, { headers: { Accept: "application/json" } }),
  );
  assert.equal(hiddenResponse.status, 404);

  const finalizeResponse = await handle(new Request(`${recordUrl}/finalize`, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: `Bearer ${capability}` },
  }));
  assert.equal(finalizeResponse.status, 200);
  assert.equal(records.puts.length, 2);
  assert.equal(records.puts[1].options.expirationTtl, TRADE_RECORD_RETENTION_SECONDS);

  const getResponse = await handle(
    new Request(recordUrl, { headers: { Accept: "application/json" } }),
  );
  assert.equal(getResponse.status, 200);
  const fetched = canonicalizeTradeRecordApiSuccess(await getResponse.json());
  assert.deepEqual(fetched.record, created.record);
  assert.equal(fetched.signature, created.signature);
});

test("fails a create closed without writes when its non-null management tombstone is corrupt", async () => {
  const { handle, records } = await signingEnvironment();
  const request = createRequest(validDraft());
  const capability = request.headers.get("Idempotency-Key");
  const tokenHash = await sha256Base64Url(capability);
  records.values.set(managementKey(tokenHash), "not-json");
  const expectedValues = new Map(records.values);

  await assertStorageCorruptResponse(await handle(request));
  assertStorageUnchanged(records, expectedValues);
});

test("fails GET, finalize, and revoke closed without writes when a management tombstone is corrupt", async (t) => {
  for (const operation of ["GET", "finalize", "revoke"]) {
    await t.test(operation, async () => {
      const { capability, created, handle, recordUrl, records } = await finalizedManagedRecordFixture();
      const tokenHash = await sha256Base64Url(capability);
      records.values.set(managementKey(tokenHash), "not-json");
      records.puts.length = 0;
      records.deletes.length = 0;
      const expectedValues = new Map(records.values);
      const request = operation === "GET"
        ? new Request(recordUrl)
        : new Request(operation === "finalize" ? `${recordUrl}/finalize` : recordUrl, {
          method: operation === "finalize" ? "POST" : "DELETE",
          headers: { Authorization: `Bearer ${capability}` },
        });

      await assertStorageCorruptResponse(await handle(request));
      assert.equal(created.id, tokenHash.slice(0, 16));
      assertStorageUnchanged(records, expectedValues);
    });
  }
});

test("refuses to finalize a pending record whose Lightning invoice has under 120 seconds left", async () => {
  const { handle, records } = await signingEnvironment();
  const request = createRequest(validDraft());
  const capability = request.headers.get("Idempotency-Key");
  const createResponse = await handle(request);
  assert.equal(createResponse.status, 201);
  const created = canonicalizeTradeRecordApiSuccess(await createResponse.json());

  const storedKey = records.puts[0].key;
  const stored = JSON.parse(records.values.get(storedKey));
  stored.signed.record.payment = {
    rail: "lightning",
    payload: "lnbc-test-finalize-boundary",
    expiresAt: new Date(Date.now() + 119_000).toISOString(),
  };
  records.values.set(storedKey, JSON.stringify(stored));

  const response = await handle(new Request(`https://records.example/api/trade-record/${created.id}/finalize`, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: `Bearer ${capability}` },
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "PAYMENT_EXPIRING");
  assert.equal(records.puts.length, 1, "an expiring pending record must not be made public");
});

test("binds one exact canonical BIP21 payment target to the signed sats", async () => {
  const { handle, publicKeys } = await signingEnvironment();
  const request = createOnchainRequest(ADDRESS, 1_000_000n);
  const response = await handle(createRequest(validDraft({
    rail: "onchain",
    address: ADDRESS,
    payload: request.uri,
  })));
  assert.equal(response.status, 201);
  const created = canonicalizeTradeRecordApiSuccess(await response.json());
  assert.deepEqual(created.record.payment, {
    rail: "onchain",
    payload: request.uri,
    address: ADDRESS,
  });
  assert.equal((await verifyTradeRecordSignature(created, { publicKeys })).status, "valid");

  const wrongAmount = request.uri.replace("amount=0.01", "amount=0.02");
  const rejected = await handle(createRequest(validDraft({
    rail: "onchain",
    address: ADDRESS,
    payload: wrongAmount,
  })));
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, "PAYMENT_AMOUNT_MISMATCH");
});

test("preserves address-only onchain and Lightning targets without inventing an amount request", async () => {
  const onchainEnvironment = await signingEnvironment();
  const onchainResponse = await onchainEnvironment.handle(createRequest(validDraft({
    rail: "onchain",
    address: ADDRESS,
    payload: ADDRESS,
  })));
  assert.equal(onchainResponse.status, 201);
  const onchain = canonicalizeTradeRecordApiSuccess(await onchainResponse.json());
  assert.deepEqual(onchain.record.payment, { rail: "onchain", payload: ADDRESS, address: ADDRESS });
  assert.equal((await verifyTradeRecordSignature(onchain, { publicKeys: onchainEnvironment.publicKeys })).status, "valid");

  const lightningEnvironment = await signingEnvironment();
  const lightningAddress = "seller@example.com";
  const lightningResponse = await lightningEnvironment.handle(createRequest(validDraft({
    rail: "lightning",
    payload: lightningAddress,
    address: lightningAddress,
  })));
  assert.equal(lightningResponse.status, 201);
  const lightning = canonicalizeTradeRecordApiSuccess(await lightningResponse.json());
  assert.deepEqual(lightning.record.payment, { rail: "lightning", payload: lightningAddress, address: lightningAddress });
  assert.equal((await verifyTradeRecordSignature(lightning, { publicKeys: lightningEnvironment.publicKeys })).status, "valid");
});

test("rejects inconsistent or expanded condition schemas before signing", async () => {
  const { handle, records } = await signingEnvironment();
  const inconsistent = validDraft();
  inconsistent.condition.sats += 1;
  const inconsistentResponse = await handle(createRequest(inconsistent));
  assert.equal(inconsistentResponse.status, 400);
  assert.equal((await inconsistentResponse.json()).code, "INCONSISTENT_CONDITION");

  const expanded = validDraft();
  expanded.condition.memo = "must not be signed";
  const expandedResponse = await handle(createRequest(expanded));
  assert.equal(expandedResponse.status, 400);
  assert.equal((await expandedResponse.json()).code, "INVALID_CONDITION");
  assert.equal(records.puts.length, 0);
});

test("detects logical record tampering while accepting the original", async () => {
  const { handle, publicKeys } = await signingEnvironment();
  const response = await handle(createRequest(validDraft()));
  const created = canonicalizeTradeRecordApiSuccess(await response.json());
  const tampered = structuredClone(created);
  tampered.record.condition.fundingSource = "사업소득";

  const originalResult = await verifyTradeRecordSignature(created, { publicKeys });
  const tamperedResult = await verifyTradeRecordSignature(tampered, { publicKeys });
  assert.equal(originalResult.status, "valid");
  assert.equal(tamperedResult.status, "invalid-signature");
});

test("fails closed for unknown keys, unavailable bindings, oversized bodies, and wrong methods", async () => {
  const { environment, handle } = await signingEnvironment();
  const response = await handle(createRequest(validDraft()));
  const created = canonicalizeTradeRecordApiSuccess(await response.json());
  assert.equal((await verifyTradeRecordSignature(created, { publicKeys: {} })).status, "unknown-key");

  const noStorage = await handle(createRequest(validDraft()), {
    ...environment,
    TRADE_RECORDS: undefined,
  });
  assert.equal(noStorage.status, 503);
  assert.equal((await noStorage.json()).code, "STORAGE_UNAVAILABLE");

  const noRateLimiter = await handleTradeRecordRequest(createRequest(validDraft()), {
    DEPLOYMENT_ENV: "production",
    TRADE_RECORDS_ENABLED: true,
    TRADE_RECORDS: environment.TRADE_RECORDS,
    TRADE_RECORD_SIGNING_KEY: environment.TRADE_RECORD_SIGNING_KEY,
  }, { allowLegacyKv: true });
  assert.equal(noRateLimiter.status, 503);
  assert.equal((await noRateLimiter.json()).code, "RATE_LIMIT_UNAVAILABLE");

  const oversized = await handle(new Request("https://records.example/api/trade-record", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.10", "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(8_500) }),
  }));
  assert.equal(oversized.status, 413);

  const wrongMethod = await handle(new Request("https://records.example/api/trade-record"));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const misleadingContentType = createRequest(validDraft());
  misleadingContentType.headers.set("Content-Type", "application/jsonp");
  const wrongContentType = await handle(misleadingContentType);
  assert.equal(wrongContentType.status, 415);
});

test("refuses to store records when the signing secret does not match the committed public key", async () => {
  const { environment, records } = await signingEnvironment();
  const privateJwk = JSON.parse(environment.TRADE_RECORD_SIGNING_KEY);
  privateJwk.kid = "p2p-trade-record-2026-08-25";
  const response = await handleTradeRecordRequest(createRequest(validDraft()), {
    ...environment,
    TRADE_RECORD_SIGNING_KEY: JSON.stringify(privateJwk),
  }, { allowLegacyKv: true });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "SIGNING_UNAVAILABLE");
  assert.equal(records.puts.length, 0);
});

test("independently checks the submitted reference against fresh Upbit REST data", async () => {
  const { handle, records } = await signingEnvironment();
  const mismatch = await handle(createRequest(validDraft()), undefined, {
    fetcher: upbitPriceFetcher(102_000_001),
  });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, "REFERENCE_PRICE_MISMATCH");
  assert.equal(records.puts.length, 0);

  const staleUpbit = await handle(createRequest(validDraft()), undefined, {
    fetcher: upbitPriceFetcher(100_000_000, Date.now() - 3 * 60_000),
  });
  assert.equal(staleUpbit.status, 503);
  assert.equal((await staleUpbit.json()).code, "MARKET_VERIFICATION_UNAVAILABLE");
  assert.equal(records.puts.length, 0);
});

test("independently checks a submitted Korea premium before including it in the signature", async () => {
  const fixture = await signingEnvironment();
  const matchingDraft = validDraft();
  matchingDraft.condition.koreaPremiumRatio = 0.0213;
  const verifiedUrls = [];
  const verified = await fixture.handle(createRequest(matchingDraft), undefined, {
    fetcher: async (input, init) => {
      const url = String(input);
      verifiedUrls.push(url);
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal instanceof AbortSignal);
      if (url === "https://api.upbit.com/v1/ticker?markets=KRW-BTC") {
        return Response.json([{
          market: "KRW-BTC",
          trade_price: 100_000_000,
          trade_timestamp: Date.now(),
        }]);
      }
      assert.equal(url, "https://datalab-api.upbit.com/api/v1/indicator/premium/assets?symbols=BTC");
      return Response.json({
        data: { records: [{ code: "CRIX.UPBIT.KRW-BTC", disparityRate: 2.13 }] },
      });
    },
  });
  assert.equal(verified.status, 201);
  const created = canonicalizeTradeRecordApiSuccess(await verified.json());
  assert.equal(created.record.condition.koreaPremiumRatio, 0.0213);
  assert.deepEqual(new Set(verifiedUrls), new Set([
    "https://api.upbit.com/v1/ticker?markets=KRW-BTC",
    "https://datalab-api.upbit.com/api/v1/indicator/premium/assets?symbols=BTC",
  ]));

  const mismatching = await signingEnvironment();
  const forgedDraft = validDraft();
  forgedDraft.condition.koreaPremiumRatio = 0.4;
  const rejected = await mismatching.handle(createRequest(forgedDraft), undefined, {
    fetcher: async (input) => String(input).includes("datalab-api")
      ? Response.json({ data: { records: [{ code: "CRIX.UPBIT.KRW-BTC", disparityRate: 2.13 }] } })
      : Response.json([{
        market: "KRW-BTC",
        trade_price: 100_000_000,
        trade_timestamp: Date.now(),
      }]),
  });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, "KOREA_PREMIUM_MISMATCH");
  assert.equal(mismatching.records.puts.length, 0);
});

test("accepts exactly 0, 1, or 2 allowlisted Upbit redirects before signing", async () => {
  for (const redirectCount of [0, 1, 2]) {
    const allowed = await signingEnvironment();
    const allowedCalls = [];
    const response = await allowed.handle(createRequest(validDraft()), undefined, {
      fetcher: async (input, init) => {
        assert.equal(init?.redirect, "manual");
        assert.ok(init?.signal instanceof AbortSignal);
        allowedCalls.push(String(input));
        if (allowedCalls.length <= redirectCount) {
          return new Response(null, {
            status: 302,
            headers: { Location: "/v1/ticker?markets=KRW-BTC" },
          });
        }
        return Response.json([{
          market: "KRW-BTC",
          trade_price: 100_000_000,
          trade_timestamp: Date.now(),
        }]);
      },
    });
    assert.equal(response.status, 201, `${redirectCount} redirects must be accepted`);
    assert.equal(allowedCalls.length, redirectCount + 1);
    assert.ok(
      allowedCalls.every((url) => url === "https://api.upbit.com/v1/ticker?markets=KRW-BTC"),
      "every followed request must remain on the exact allowlisted endpoint",
    );
    assert.equal(allowed.records.puts.length, 1);
  }
});

test("rejects untrusted or more than 2 Upbit redirects before signing", async () => {

  for (const location of [
    "https://example.com/v1/ticker?markets=KRW-BTC",
    "http://api.upbit.com/v1/ticker?markets=KRW-BTC",
    "https://api.upbit.com/v1/orders?markets=KRW-BTC",
    "https://api.upbit.com/v1/ticker?markets=KRW-BTC&extra=1",
    null,
  ]) {
    const rejected = await signingEnvironment();
    let calls = 0;
    const response = await rejected.handle(createRequest(validDraft()), undefined, {
      fetcher: async () => {
        calls += 1;
        assert.equal(calls, 1, "an untrusted redirect must not receive a follow-up request");
        return new Response(null, {
          status: 302,
          headers: location === null ? undefined : { Location: location },
        });
      },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "MARKET_VERIFICATION_UNAVAILABLE");
    assert.equal(rejected.records.puts.length, 0);
  }

  const looping = await signingEnvironment();
  let loopCalls = 0;
  const redirectLoop = await looping.handle(createRequest(validDraft()), undefined, {
    fetcher: async () => {
      loopCalls += 1;
      return new Response(null, {
        status: 302,
        headers: { Location: "/v1/ticker?markets=KRW-BTC" },
      });
    },
  });
  assert.equal(redirectLoop.status, 503);
  assert.equal((await redirectLoop.json()).code, "MARKET_VERIFICATION_UNAVAILABLE");
  assert.equal(loopCalls, 3);
  assert.equal(looping.records.puts.length, 0);
});

test("fails closed on Upbit 429 and aborts the in-flight verification at its deadline", async (t) => {
  const throttled = await signingEnvironment();
  let throttledCalls = 0;
  const throttledResponse = await throttled.handle(createRequest(validDraft()), undefined, {
    fetcher: async (_input, init) => {
      throttledCalls += 1;
      assert.equal(init?.redirect, "manual");
      return Response.json({ error: { name: "too_many_requests" } }, { status: 429 });
    },
  });
  assert.equal(throttledResponse.status, 503);
  assert.equal((await throttledResponse.json()).code, "MARKET_VERIFICATION_UNAVAILABLE");
  assert.equal(throttledCalls, 1);
  assert.equal(throttled.records.puts.length, 0);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timedOut = await signingEnvironment();
  let observedSignal;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const pendingResponse = timedOut.handle(createRequest(validDraft()), undefined, {
      fetcher: async (_input, init) => {
        observedSignal = init?.signal;
        markFetchStarted();
        return await new Promise((_resolve, reject) => {
          observedSignal.addEventListener("abort", () => reject(observedSignal.reason), { once: true });
        });
      },
    });
    await fetchStarted;
    assert.equal(observedSignal.aborted, false);
    t.mock.timers.tick(4_000);
    const timeoutResponse = await pendingResponse;
    assert.equal(observedSignal.aborted, true);
    assert.equal(timeoutResponse.status, 503);
    assert.equal((await timeoutResponse.json()).code, "MARKET_VERIFICATION_UNAVAILABLE");
    assert.equal(timedOut.records.puts.length, 0);
  } finally {
    console.error = originalError;
    t.mock.timers.reset();
  }
});

test("aborts a stalled Upbit response body at the same verification deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timedOut = await signingEnvironment();
  let observedSignal;
  let markBodyReadStarted;
  const bodyReadStarted = new Promise((resolve) => {
    markBodyReadStarted = resolve;
  });

  try {
    const pendingResponse = timedOut.handle(createRequest(validDraft()), undefined, {
      fetcher: async (_input, init) => {
        observedSignal = init?.signal;
        return new Response(new ReadableStream({
          pull() {
            markBodyReadStarted();
            return new Promise(() => {});
          },
          cancel() {
            return new Promise(() => {});
          },
        }), { headers: { "Content-Type": "application/json" } });
      },
    });

    await bodyReadStarted;
    assert.equal(observedSignal.aborted, false);
    t.mock.timers.tick(4_000);
    const timeoutResponse = await pendingResponse;
    assert.equal(observedSignal.aborted, true);
    assert.equal(timeoutResponse.status, 503);
    assert.equal((await timeoutResponse.json()).code, "MARKET_VERIFICATION_UNAVAILABLE");
    assert.equal(timedOut.records.puts.length, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test("rate-limits create calls by Cloudflare connecting IP before external work or KV writes", async () => {
  const { handle, rateLimiter, records } = await signingEnvironment();
  rateLimiter.success = false;
  const response = await handle(createRequest(validDraft()));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal((await response.json()).code, "RATE_LIMITED");
  assert.deepEqual(rateLimiter.calls, [{ key: "trade-record:create:203.0.113.10" }]);
  assert.equal(records.puts.length, 0);
});

test("retries a fresh-record 404 and lets AbortSignal stop propagation waiting", async () => {
  const { handle } = await signingEnvironment();
  const createResponse = await handle(createRequest(validDraft()));
  const created = canonicalizeTradeRecordApiSuccess(await createResponse.json());
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  try {
    globalThis.fetch = async () => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ ok: false, code: "RECORD_NOT_FOUND", message: "not propagated" }, { status: 404 })
        : Response.json(created);
    };
    const retried = await fetchTradeRecord(created.id, {
      endpointBase: "https://records.example/api/trade-record",
      retryNotFound: true,
    });
    assert.equal(retried.id, created.id);
    assert.equal(attempts, 2);

    const wrongId = "BBBBBBBBBBBBBBBB";
    globalThis.fetch = async () => Response.json({
      ...created,
      id: wrongId,
      record: { ...created.record, id: wrongId },
      verificationUrl: `https://records.example/verify/?id=${wrongId}`,
    });
    await assert.rejects(
      fetchTradeRecord(created.id, { endpointBase: "https://records.example/api/trade-record" }),
      /조회 응답을 확인하지 못했습니다/u,
    );

    globalThis.fetch = async () => Response.json(
      { ok: false, code: "RECORD_NOT_FOUND", message: "not propagated" },
      { status: 404 },
    );
    const controller = new AbortController();
    const pending = fetchTradeRecord(created.id, {
      endpointBase: "https://records.example/api/trade-record",
      retryNotFound: true,
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());
    await assert.rejects(pending, (error) => error?.name === "AbortError");

    globalThis.fetch = async () => new Response("x".repeat(17_000), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(
      fetchTradeRecord(created.id, { endpointBase: "https://records.example/api/trade-record" }),
      /응답이 너무 큽니다/u,
    );

    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(
      fetchTradeRecord(created.id, { endpointBase: "https://records.example/api/trade-record" }),
      (error) => error instanceof TradeRecordNetworkError && error.cause instanceof TypeError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounds a trade-record GET whose fetch never resolves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let observedSignal;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });

  try {
    globalThis.fetch = async (_input, init) => {
      observedSignal = init?.signal;
      markFetchStarted();
      return await new Promise((_resolve, reject) => {
        observedSignal.addEventListener("abort", () => reject(observedSignal.reason), { once: true });
      });
    };

    const pending = fetchTradeRecord("AAAAAAAAAAAAAAAA", {
      endpointBase: "https://records.example/api/trade-record",
      timeoutMs: 1_000,
    });
    await fetchStarted;
    const rejected = assert.rejects(
      pending,
      (error) => error instanceof TradeRecordApiRequestError
        && error.code === "REQUEST_TIMEOUT"
        && error.status === 0,
    );
    t.mock.timers.tick(1_000);
    await rejected;
    assert.equal(observedSignal.aborted, true);
    assert.equal(observedSignal.reason?.name, "TimeoutError");
  } finally {
    globalThis.fetch = originalFetch;
    t.mock.timers.reset();
  }
});

test("bounds a trade-record GET whose JSON body stream stops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  let observedSignal;
  let cancelled = false;
  let markPullStarted;
  const pullStarted = new Promise((resolve) => {
    markPullStarted = resolve;
  });

  try {
    globalThis.fetch = async (_input, init) => {
      observedSignal = init?.signal;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
        },
        pull() {
          markPullStarted();
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    };

    const pending = fetchTradeRecord("AAAAAAAAAAAAAAAA", {
      endpointBase: "https://records.example/api/trade-record",
      timeoutMs: 1_000,
    });
    await pullStarted;
    const rejected = assert.rejects(
      pending,
      (error) => error instanceof TradeRecordApiRequestError
        && error.code === "REQUEST_TIMEOUT"
        && error.status === 0,
    );
    t.mock.timers.tick(1_000);
    await rejected;
    assert.equal(observedSignal.aborted, true);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
    t.mock.timers.reset();
  }
});

test("rejects a non-JSON trade-record response without awaiting stalled body cancellation", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const didNotSettle = Symbol("did-not-settle");

  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not JSON"));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    }), { headers: { "Content-Type": "text/plain" } });

    const outcome = await Promise.race([
      fetchTradeRecord("AAAAAAAAAAAAAAAA", {
        endpointBase: "https://records.example/api/trade-record",
        timeoutMs: 1_000,
      }).then(() => null, (error) => error),
      new Promise((resolve) => setTimeout(() => resolve(didNotSettle), 100)),
    ]);
    assert.notEqual(outcome, didNotSettle);
    assert.match(outcome?.message ?? "", /JSON 응답을 반환하지 않았습니다/u);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an oversized streamed response without awaiting stalled reader cancellation", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const didNotSettle = Symbol("did-not-settle");

  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(17_000));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    }), { headers: { "Content-Type": "application/json" } });

    const outcome = await Promise.race([
      fetchTradeRecord("AAAAAAAAAAAAAAAA", {
        endpointBase: "https://records.example/api/trade-record",
        timeoutMs: 1_000,
      }).then(() => null, (error) => error),
      new Promise((resolve) => setTimeout(() => resolve(didNotSettle), 100)),
    ]);
    assert.notEqual(outcome, didNotSettle);
    assert.match(outcome?.message ?? "", /응답이 너무 큽니다/u);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes a non-timeout response body stream failure as a retryable network error", async () => {
  const originalFetch = globalThis.fetch;

  try {
    const streamFailure = new TypeError("network connection lost while reading body");
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(controller) {
        controller.error(streamFailure);
      },
    }), { headers: { "Content-Type": "application/json" } });

    await assert.rejects(
      fetchTradeRecord("AAAAAAAAAAAAAAAA", {
        endpointBase: "https://records.example/api/trade-record",
        timeoutMs: 1_000,
      }),
      (error) => error instanceof TradeRecordNetworkError
        && error.cause === streamFailure
        && isRetryableTradeRecordFetchError(error),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not classify HTTP or response-content validation failures as network errors", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => Response.json(
      { ok: false, code: "INVALID_REQUEST", message: "invalid record" },
      { status: 400 },
    );
    await assert.rejects(
      fetchTradeRecord("AAAAAAAAAAAAAAAA", {
        endpointBase: "https://records.example/api/trade-record",
      }),
      (error) => error instanceof TradeRecordApiRequestError
        && !(error instanceof TradeRecordNetworkError)
        && error.code === "INVALID_REQUEST",
    );

    globalThis.fetch = async () => new Response("not JSON", {
      headers: { "Content-Type": "text/plain" },
    });
    await assert.rejects(
      fetchTradeRecord("AAAAAAAAAAAAAAAA", {
        endpointBase: "https://records.example/api/trade-record",
      }),
      (error) => error instanceof Error
        && !(error instanceof TradeRecordNetworkError)
        && /JSON 응답을 반환하지 않았습니다/u.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("treats trade-record timeouts as retryable verification failures", () => {
  assert.equal(
    isRetryableTradeRecordFetchError(new TradeRecordApiRequestError("REQUEST_TIMEOUT", "timeout", 0)),
    true,
  );
  assert.equal(
    isRetryableTradeRecordFetchError(new TradeRecordApiRequestError("NOT_FOUND", "not found", 404)),
    true,
  );
  assert.equal(isRetryableTradeRecordFetchError(new TradeRecordNetworkError(new TypeError("offline"))), true);
  assert.equal(
    isRetryableTradeRecordFetchError(new TradeRecordApiRequestError("INVALID_REQUEST", "invalid", 400)),
    false,
  );
  assert.equal(isRetryableTradeRecordFetchError(new Error("invalid signature")), false);
});

test("committed deployment public JWK is structurally valid and verification route is wired in both entries", async () => {
  const [deploymentPublicKey] = Object.values(TRADE_RECORD_PUBLIC_KEYS);
  const imported = await crypto.subtle.importKey(
    "jwk",
    deploymentPublicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert.equal(imported.type, "public");

  const [worker, prerender, page, verifier, wrangler] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/prerender.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/verify/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/verify/TradeRecordVerifier.tsx", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /isTradeRecordApiPath/);
  assert.match(prerender, /isTradeRecordApiPath/);
  assert.match(page, /images:\s*\[\]/);
  assert.match(page, /robots:\s*\{\s*index:\s*false/);
  assert.match(verifier, /주소·인보이스·금액을 상대방과 지갑에서 다시 확인/);
  assert.match(verifier, /retryNotFound:\s*true/);
  assert.match(wrangler, /"ratelimits"/);
  assert.match(wrangler, /"name":\s*"TRADE_RECORD_CREATE_RATE_LIMITER"/);
});
