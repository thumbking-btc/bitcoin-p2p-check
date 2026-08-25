import assert from "node:assert/strict";
import test from "node:test";

import {
  cacheAttemptFile,
  cacheAttemptRecord,
  createLargeTradeConfirmationKey,
  createPreparedTradeShare,
  createShareAttempt,
  isPaymentShareableAt,
  isTradeShareTransitionSafe,
  matchingShareAttempt,
  recordShareDelivery,
  removeManagedTradeRecord,
  tradeRecordPaymentExpiresAt,
  toManagedTradeRecord,
  upsertManagedTradeRecord,
} from "../app/lib/trade-share-session.ts";

function signedRecord({
  id = "record-1",
  lifecycle = "pending",
  payment = null,
  verificationUrl = "https://example.test/verify/record-1",
} = {}) {
  return {
    id,
    lifecycle,
    verificationUrl,
    record: {
      payment,
      condition: { marketObservedAt: "2027-01-15T08:00:00.000Z" },
    },
  };
}

test("a share attempt is reused only for the same condition key and gains render artifacts immutably", () => {
  const initial = createShareAttempt("condition-a", "revoke-token-a");
  const signed = signedRecord();
  const file = { name: "trade.png", type: "image/png" };

  assert.equal(matchingShareAttempt(initial, "condition-a"), initial);
  assert.equal(matchingShareAttempt(initial, "condition-b"), null);

  const withRecord = cacheAttemptRecord(initial, signed);
  const withFile = cacheAttemptFile(withRecord, file);
  assert.equal(initial.signed, undefined);
  assert.equal(withRecord.signed, signed);
  assert.equal(withRecord.file, undefined);
  assert.equal(withFile.signed, signed);
  assert.equal(withFile.file, file);
});

test("prepared delivery state retains the pending record and does not mutate the private preparation", () => {
  const attempt = createShareAttempt("condition-a", "revoke-token-a");
  const signed = signedRecord({ payment: { rail: "onchain" } });
  const file = { name: "trade.png", type: "image/png" };
  const prepared = createPreparedTradeShare(attempt, signed, file, "거래 조건");
  const delivered = recordShareDelivery(prepared, "downloaded", "copied");

  assert.equal(prepared.deliveryOutcome, undefined);
  assert.equal(delivered.deliveryOutcome, "downloaded");
  assert.equal(delivered.verificationUrlDelivery, "copied");
  assert.equal(delivered.signed, signed);
  assert.equal(delivered.revokeToken, "revoke-token-a");
  assert.match(delivered.text, /확인된 결제정보/u);
  assert.match(delivered.text, /https:\/\/example\.test\/verify\/record-1/u);
});

test("share transitions require the same conditions, an allowed lifecycle, and a fresh market reference", () => {
  const now = Date.parse("2027-01-15T08:05:00.000Z");
  const base = {
    currentAttemptKey: "condition-a",
    candidateAttemptKey: "condition-a",
    preparationAllowed: true,
    receiveInfoLifecycleStatus: "ready",
    marketObservedAt: new Date(now - 299_999).toISOString(),
    now,
  };

  assert.equal(isTradeShareTransitionSafe(base), true);
  assert.equal(isTradeShareTransitionSafe({ ...base, candidateAttemptKey: "condition-b" }), false);
  assert.equal(isTradeShareTransitionSafe({ ...base, preparationAllowed: false }), false);
  for (const receiveInfoLifecycleStatus of ["stale", "expiring", "expired"]) {
    assert.equal(isTradeShareTransitionSafe({ ...base, receiveInfoLifecycleStatus }), false);
  }
  assert.equal(isTradeShareTransitionSafe({
    ...base,
    marketObservedAt: new Date(now - 300_000).toISOString(),
  }), false);

  const paymentExpiresAt = new Date(now + 121_000).toISOString();
  const paymentBase = { ...base, marketObservedAt: new Date(now).toISOString(), paymentExpiresAt };
  assert.equal(isPaymentShareableAt(paymentExpiresAt, now), true);
  assert.equal(isTradeShareTransitionSafe({ ...paymentBase, now: now + 1_000 }), true);
  assert.equal(isTradeShareTransitionSafe({ ...paymentBase, now: now + 1_001 }), false);
  assert.equal(isTradeShareTransitionSafe({ ...paymentBase, now: now + 2_000 }), false);
  assert.equal(isPaymentShareableAt("not-a-time", now), false);

  const signed = signedRecord({
    payment: { rail: "lightning", payload: "lnbc-test", expiresAt: paymentExpiresAt },
  });
  assert.equal(tradeRecordPaymentExpiresAt(signed), paymentExpiresAt);
  assert.equal(tradeRecordPaymentExpiresAt(signedRecord()), null);
});

test("large-trade confirmation is bound to both exact settlement outputs", () => {
  const base = {
    role: "seller",
    amountBasis: "bitcoin",
    paymentKrw: 1_000_000_000,
    sats: 1_000_000_000,
  };
  const confirmed = createLargeTradeConfirmationKey(base);
  assert.notEqual(confirmed, "");
  assert.equal(createLargeTradeConfirmationKey({ ...base, paymentKrw: 999_999_999 }), "");
  assert.notEqual(
    createLargeTradeConfirmationKey({ ...base, paymentKrw: 10_999_900_000 }),
    confirmed,
    "a premium-driven KRW change must require a new confirmation even when sats stay fixed",
  );
  assert.notEqual(
    createLargeTradeConfirmationKey({ ...base, sats: base.sats + 1 }),
    confirmed,
    "a changed BTC settlement amount must also require a new confirmation",
  );
});

test("managed records are deduplicated by id, moved to their latest position, and removable", () => {
  const firstPending = toManagedTradeRecord(signedRecord(), "revoke-token-a");
  const second = toManagedTradeRecord(signedRecord({
    id: "record-2",
    verificationUrl: "https://example.test/verify/record-2",
  }), "revoke-token-b");
  const firstFinalized = toManagedTradeRecord(signedRecord({ lifecycle: "finalized" }), "revoke-token-a", "finalized");

  const original = [firstPending, second];
  const updated = upsertManagedTradeRecord(original, firstFinalized);
  assert.deepEqual(updated, [second, firstFinalized]);
  assert.deepEqual(original, [firstPending, second]);
  assert.deepEqual(removeManagedTradeRecord(updated, "record-2"), [firstFinalized]);
});
