import assert from "node:assert/strict";
import test from "node:test";

import {
  fail,
  json,
  methodNotAllowed,
  TradeRecordRequestError,
} from "../worker/trade-record-http.ts";
import {
  assertTradeRecordPaymentFinalizable,
  authorizationToken,
  createRevokeToken,
  managementKey,
  MIN_LIGHTNING_PAYMENT_REMAINING_SECONDS,
  parseCreateLifecycle,
  parseManagementIndex,
  parseStoredRecord,
  PENDING_RECORD_TTL_SECONDS,
  recordsExplicitlyDisabled,
  recordTtl,
  sha256Base64Url,
  storageKey,
  storedManagedRecord,
} from "../worker/trade-record-lifecycle.ts";
import {
  getTradeRecordRetentionPolicy,
  TRADE_RECORD_SCHEMA_V1,
} from "../app/lib/trade-record.ts";

const CAPABILITY = "A".repeat(43);
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const RETENTION_SECONDS = getTradeRecordRetentionPolicy(TRADE_RECORD_SCHEMA_V1).retentionSeconds;
const EXPIRES_AT = new Date(Date.parse(CREATED_AT) + RETENTION_SECONDS * 1_000).toISOString();

function signedRecord() {
  return {
    record: {
      schema: TRADE_RECORD_SCHEMA_V1,
      id: "AAAAAAAAAAAAAAAA",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      condition: {
        role: "buyer",
        amountBasis: "krw",
        bitcoinDisplayUnit: "sats",
        paymentKrw: 1_000_000,
        sats: 1_000_000,
        referencePriceKrw: 100_000_000,
        marketObservedAt: CREATED_AT,
        koreaPremiumRatio: null,
        sellerPremiumBps: 0,
        fundingSource: null,
      },
      payment: null,
    },
    signature: "A".repeat(86),
    keyId: "trade-record-worker-module-test",
  };
}

function assertRequestError(error, code, status) {
  assert.ok(error instanceof TradeRecordRequestError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return true;
}

test("trade-record HTTP responses retain their security headers and structured request errors", async () => {
  const response = json({ ok: true }, 201, { "Retry-After": "60" });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(await response.json(), { ok: true });

  const wrongMethod = methodNotAllowed("GET, DELETE");
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, DELETE");
  assert.deepEqual(await wrongMethod.json(), {
    ok: false,
    code: "METHOD_NOT_ALLOWED",
    message: "GET, DELETE 요청만 사용할 수 있습니다.",
  });

  assert.throws(
    () => fail("RATE_LIMITED", "잠시 후 다시 시도하십시오.", 429, { "Retry-After": "60" }),
    (error) => {
      assertRequestError(error, "RATE_LIMITED", 429);
      assert.equal(new Headers(error.headers).get("retry-after"), "60");
      return true;
    },
  );
});

test("lifecycle header and capability parsing preserve exact fail-closed contracts", () => {
  const create = new Request("https://records.example/api/trade-record", {
    headers: {
      "Idempotency-Key": CAPABILITY,
      "X-Trade-Record-Lifecycle": "pending",
    },
  });
  assert.equal(parseCreateLifecycle(create), "pending");
  assert.equal(createRevokeToken(create), CAPABILITY);
  assert.equal(authorizationToken(new Request(create.url, {
    headers: { Authorization: `Bearer ${CAPABILITY}` },
  })), CAPABILITY);

  assert.throws(
    () => parseCreateLifecycle(new Request(create.url)),
    (error) => assertRequestError(error, "CLIENT_UPGRADE_REQUIRED", 400),
  );
  assert.throws(
    () => createRevokeToken(new Request(create.url)),
    (error) => assertRequestError(error, "IDEMPOTENCY_KEY_REQUIRED", 400),
  );
  assert.throws(
    () => authorizationToken(new Request(create.url)),
    (error) => {
      assertRequestError(error, "INVALID_CAPABILITY", 401);
      assert.equal(new Headers(error.headers).get("www-authenticate"), "Bearer");
      return true;
    },
  );
});

test("lifecycle storage helpers keep deterministic keys and managed/legacy envelopes", async () => {
  const tokenHash = await sha256Base64Url(CAPABILITY);
  assert.match(tokenHash, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(storageKey("AAAAAAAAAAAAAAAA"), "trade-record:v1:AAAAAAAAAAAAAAAA");
  assert.equal(managementKey(tokenHash), `trade-record:v1:manage:${tokenHash}`);

  const signed = signedRecord();
  const managed = storedManagedRecord(signed, "pending", tokenHash);
  assert.equal(Object.isFrozen(managed), true);
  assert.deepEqual(parseStoredRecord(JSON.stringify(managed)), {
    signed,
    lifecycle: "pending",
    tokenHash,
  });
  assert.deepEqual(parseStoredRecord(JSON.stringify(signed)), {
    signed,
    lifecycle: "finalized",
    tokenHash: null,
  });

  const index = JSON.stringify({ version: 1, id: signed.record.id, state: "revoked" });
  assert.deepEqual(parseManagementIndex(index), { version: 1, id: signed.record.id, state: "revoked" });
  assert.equal(parseManagementIndex(null), null);
  for (const corruptIndex of [
    "not-json",
    "x".repeat(513),
    JSON.stringify({ version: 1, id: signed.record.id, state: "revoked", extra: true }),
    JSON.stringify({ version: 2, id: signed.record.id, state: "revoked" }),
    JSON.stringify({ version: 1, id: "too-short", state: "revoked" }),
    JSON.stringify({ version: 1, id: signed.record.id, state: "active" }),
  ]) {
    assert.throws(
      () => parseManagementIndex(corruptIndex),
      (error) => assertRequestError(error, "STORAGE_CORRUPT", 500),
    );
  }
  assert.throws(
    () => parseStoredRecord("not-json"),
    (error) => assertRequestError(error, "STORAGE_CORRUPT", 500),
  );
});

test("lifecycle TTL and environment gating retain pending and absolute-expiry semantics", () => {
  const signed = signedRecord();
  const createdAtMs = Date.parse(CREATED_AT);
  assert.equal(PENDING_RECORD_TTL_SECONDS, 15 * 60);
  assert.equal(recordTtl(signed, createdAtMs), RETENTION_SECONDS);
  assert.equal(recordTtl(signed, createdAtMs + 1_234), RETENTION_SECONDS - 1);
  assert.throws(
    () => recordTtl(signed, Date.parse(EXPIRES_AT)),
    (error) => assertRequestError(error, "RECORD_EXPIRED", 404),
  );

  assert.equal(recordsExplicitlyDisabled({}), true);
  assert.equal(recordsExplicitlyDisabled({ TRADE_RECORDS_ENABLED: true }), true);
  assert.equal(recordsExplicitlyDisabled({ DEPLOYMENT_ENV: "production" }), true);
  assert.equal(recordsExplicitlyDisabled({ DEPLOYMENT_ENV: "production", TRADE_RECORDS_ENABLED: true }), false);
  assert.equal(recordsExplicitlyDisabled({ DEPLOYMENT_ENV: " Production ", TRADE_RECORDS_ENABLED: " TRUE " }), false);
  assert.equal(recordsExplicitlyDisabled({ DEPLOYMENT_ENV: "production", TRADE_RECORDS_ENABLED: "yes" }), true);
  assert.equal(recordsExplicitlyDisabled({ TRADE_RECORDS_ENABLED: false }), true);
  assert.equal(recordsExplicitlyDisabled({ TRADE_RECORDS_ENABLED: "off" }), true);
  assert.equal(recordsExplicitlyDisabled({ DEPLOYMENT_ENV: " Preview ", TRADE_RECORDS_ENABLED: true }), true);
  assert.equal(recordsExplicitlyDisabled({ DEPLOYMENT_ENV: "staging", TRADE_RECORDS_ENABLED: true }), false);
  assert.equal(recordsExplicitlyDisabled({ DEPLOYMENT_ENV: "staging", TRADE_RECORDS_ENABLED: false }), true);
  assert.equal(recordsExplicitlyDisabled({ DEPLOYMENT_ENV: "unknown", TRADE_RECORDS_ENABLED: true }), true);
});

test("pending Lightning records can finalize at 120 seconds but fail closed at 119", () => {
  const signed = signedRecord();
  const expiresAtMs = Date.parse("2026-01-01T00:10:00.000Z");
  signed.record.payment = {
    rail: "lightning",
    payload: "lnbc-test-finalize-boundary",
    expiresAt: new Date(expiresAtMs).toISOString(),
  };

  assert.equal(MIN_LIGHTNING_PAYMENT_REMAINING_SECONDS, 120);
  assert.doesNotThrow(() => assertTradeRecordPaymentFinalizable(signed, expiresAtMs - 120_000));
  assert.throws(
    () => assertTradeRecordPaymentFinalizable(signed, expiresAtMs - 119_999),
    (error) => assertRequestError(error, "PAYMENT_EXPIRING", 409),
  );
  assert.throws(
    () => assertTradeRecordPaymentFinalizable(signed, expiresAtMs - 119_000),
    (error) => assertRequestError(error, "PAYMENT_EXPIRING", 409),
  );

  signed.record.payment = {
    rail: "lightning",
    payload: "receiver@example.com",
    address: "receiver@example.com",
  };
  assert.doesNotThrow(() => assertTradeRecordPaymentFinalizable(signed, expiresAtMs));
});
