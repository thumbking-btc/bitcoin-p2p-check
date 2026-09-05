import assert from "node:assert/strict";
import test from "node:test";
import { TRADE_RECORD_SCHEMA_V1, TRADE_RECORD_SCHEMA_V2 } from "../app/lib/trade-record.ts";

import {
  cacheAttemptFile,
  cacheAttemptRecord,
  createLargeTradeConfirmationKey,
  createPreparedTradeShare,
  createShareAttempt,
  isPaymentShareableAt,
  isTradeShareTransitionSafe,
  LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY,
  loadPersistedManagedTradeRecords,
  MANAGED_TRADE_RECORD_CLOCK_SKEW_GRACE_MS,
  managedTradeRecordCleanupAt,
  managedTradeRecordStorageKey,
  managedTradeRecordPendingExpiresAt,
  parsePersistedManagedTradeRecord,
  parsePersistedManagedTradeRecords,
  persistManagedTradeRecord,
  pruneExpiredManagedTradeRecords,
  matchingShareAttempt,
  recordShareDelivery,
  removeManagedTradeRecord,
  removePersistedManagedTradeRecord,
  serializeManagedTradeRecords,
  tradeRecordPaymentExpiresAt,
  toManagedTradeRecord,
  upsertManagedTradeRecord,
} from "../app/lib/trade-share-session.ts";

function signedRecord({
  id = "record-1",
  lifecycle = "pending",
  payment = null,
  schema = TRADE_RECORD_SCHEMA_V1,
  expiresAt = "2027-07-14T08:00:00.000Z",
  verificationUrl = "https://example.test/verify/record-1",
} = {}) {
  return {
    id,
    lifecycle,
    verificationUrl,
    record: {
      schema,
      payment,
      createdAt: "2027-01-15T08:00:00.000Z",
      expiresAt,
      condition: { marketObservedAt: "2027-01-15T08:00:00.000Z" },
    },
  };
}

class MemoryStorage {
  values = new Map();
  failSetFor = null;

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    if (key === this.failSetFor) throw new Error("quota unavailable");
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
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

test("v2 management persistence retains the fourteen-day recovery window", () => {
  const now = Date.parse("2027-01-15T08:00:00.000Z");
  const id = "AAAAAAAAAAAAAAAZ";
  const expiresAt = "2027-01-29T08:00:00.000Z";
  const finalized = toManagedTradeRecord(signedRecord({
    id,
    lifecycle: "finalized",
    schema: TRADE_RECORD_SCHEMA_V2,
    expiresAt,
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), "z".repeat(43), "finalized");
  assert.equal(finalized.retentionSeconds, 14 * 24 * 60 * 60);
  const serialized = serializeManagedTradeRecords([finalized], now);
  assert.match(serialized, /"retentionSeconds":1209600/u);
  assert.deepEqual(
    parsePersistedManagedTradeRecords(serialized, "https://example.test", now),
    [{ ...finalized, persistence: "browser" }],
  );
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
  assert.equal(
    Date.parse(firstPending.expiresAt),
    Date.parse("2027-01-15T08:15:00.000Z"),
    "pending management must expire with the 15-minute private record",
  );
});

test("finalized record capabilities survive the clock-skew cleanup grace and reject tampered storage", () => {
  const now = Date.parse("2027-01-15T08:00:00.000Z");
  const id = "AAAAAAAAAAAAAAAB";
  const revokeToken = "a".repeat(43);
  const finalized = toManagedTradeRecord(signedRecord({
    id,
    lifecycle: "finalized",
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), revokeToken, "finalized");
  const pending = toManagedTradeRecord(signedRecord({
    id: "AAAAAAAAAAAAAAAC",
    verificationUrl: "https://example.test/verify/?id=AAAAAAAAAAAAAAAC",
  }), "b".repeat(43));

  const serialized = serializeManagedTradeRecords([pending, finalized], now);
  const restoredFinalized = { ...finalized, persistence: "browser" };
  assert.deepEqual(parsePersistedManagedTradeRecords(serialized, "https://example.test", now), [restoredFinalized]);
  assert.deepEqual(
    parsePersistedManagedTradeRecords(serialized, "https://other.test", now),
    [],
  );
  assert.deepEqual(
    parsePersistedManagedTradeRecords(serialized.replace(revokeToken, "short"), "https://example.test", now),
    [],
  );
  assert.equal(
    parsePersistedManagedTradeRecord(
      serialized.slice(1, -1).replace(
        "https://example.test/verify/",
        "https://user:pass@example.test/verify/",
      ),
      "https://example.test",
      now,
    ),
    null,
  );
  assert.equal(
    parsePersistedManagedTradeRecord(
      serialized.slice(1, -1).replace(`?id=${id}`, `?id=${id}&next=unexpected`),
      "https://example.test",
      now,
    ),
    null,
  );
  assert.equal(
    parsePersistedManagedTradeRecord(
      serialized.slice(1, -1).replace(finalized.expiresAt, "2099-01-01T00:00:00.000Z"),
      "https://example.test",
      now,
    ),
    null,
  );
  assert.deepEqual(
    parsePersistedManagedTradeRecords(serialized, "https://example.test", Date.parse(finalized.expiresAt)),
    [restoredFinalized],
  );
  assert.deepEqual(
    parsePersistedManagedTradeRecords(
      serialized,
      "https://example.test",
      managedTradeRecordCleanupAt(finalized) - 1,
    ),
    [restoredFinalized],
  );
  assert.deepEqual(
    parsePersistedManagedTradeRecords(
      serialized,
      "https://example.test",
      managedTradeRecordCleanupAt(finalized),
    ),
    [],
  );
  assert.deepEqual(pruneExpiredManagedTradeRecords(
    [finalized, {
      ...pending,
      expiresAt: new Date(now - MANAGED_TRADE_RECORD_CLOCK_SKEW_GRACE_MS - 1).toISOString(),
    }],
    now,
  ), [finalized]);
});

test("pending and finalizing capabilities use their correct recovery windows and never downgrade", () => {
  const now = Date.parse("2027-01-15T08:00:00.000Z");
  const id = "AAAAAAAAAAAAAAAB";
  const storage = new MemoryStorage();
  const pending = toManagedTradeRecord(signedRecord({
    id,
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), "a".repeat(43));
  const persistedPending = persistManagedTradeRecord(storage, pending, "https://example.test", now);

  assert.equal(persistedPending.lifecycle, "pending");
  assert.equal(persistedPending.persistence, "browser");
  assert.deepEqual(loadPersistedManagedTradeRecords(storage, "https://example.test", now), [persistedPending]);
  assert.deepEqual(
    loadPersistedManagedTradeRecords(storage, "https://example.test", Date.parse(pending.expiresAt)),
    [persistedPending],
    "a forward clock jump to the apparent expiry must not delete a server-valid capability",
  );
  assert.notEqual(storage.getItem(managedTradeRecordStorageKey(id)), null);
  assert.deepEqual(
    loadPersistedManagedTradeRecords(
      storage,
      "https://example.test",
      managedTradeRecordCleanupAt(pending) - 1,
    ),
    [persistedPending],
  );
  assert.deepEqual(
    loadPersistedManagedTradeRecords(storage, "https://example.test", managedTradeRecordCleanupAt(pending)),
    [],
  );
  assert.equal(
    storage.getItem(managedTradeRecordStorageKey(id)),
    null,
    "a capability is removed only after the clock-skew cleanup grace also elapses",
  );

  const finalizing = toManagedTradeRecord(signedRecord({
    id,
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), "a".repeat(43), "finalizing");
  const persistedFinalizing = persistManagedTradeRecord(storage, finalizing, "https://example.test", now);
  assert.equal(persistedFinalizing.lifecycle, "finalizing");
  assert.equal(persistedFinalizing.expiresAt, "2027-07-14T08:00:00.000Z");
  assert.equal(managedTradeRecordPendingExpiresAt(persistedFinalizing), pending.expiresAt);
  assert.equal(
    managedTradeRecordCleanupAt(persistedFinalizing),
    Date.parse(pending.expiresAt) + MANAGED_TRADE_RECORD_CLOCK_SKEW_GRACE_MS,
    "an uncertain finalization uses the pending recovery deadline instead of 180-day retention",
  );
  assert.deepEqual(
    loadPersistedManagedTradeRecords(storage, "https://example.test", Date.parse(pending.expiresAt)),
    [persistedFinalizing],
    "an unknown finalization outcome must retain its capability beyond the private-record TTL",
  );
  assert.deepEqual(
    loadPersistedManagedTradeRecords(
      storage,
      "https://example.test",
      managedTradeRecordCleanupAt(persistedFinalizing) - 1,
    ),
    [persistedFinalizing],
  );
  assert.deepEqual(
    loadPersistedManagedTradeRecords(
      storage,
      "https://example.test",
      managedTradeRecordCleanupAt(persistedFinalizing),
    ),
    [],
  );
  assert.equal(storage.getItem(managedTradeRecordStorageKey(id)), null);

  const finalized = toManagedTradeRecord(signedRecord({
    id,
    lifecycle: "finalized",
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), "a".repeat(43), "finalized");
  const persistedFinalized = persistManagedTradeRecord(storage, finalized, "https://example.test", now);
  assert.equal(persistedFinalized.lifecycle, "finalized");
  assert.deepEqual(
    persistManagedTradeRecord(storage, pending, "https://example.test", now),
    persistedFinalized,
    "a stale pending write must not replace a finalized capability",
  );
  assert.deepEqual(
    persistManagedTradeRecord(storage, finalizing, "https://example.test", now),
    persistedFinalized,
    "an uncertain finalization write must not replace a finalized capability",
  );
  assert.deepEqual(loadPersistedManagedTradeRecords(storage, "https://example.test", now), [persistedFinalized]);
});

test("a lifecycle race with a different capability fails closed without replacing either token", () => {
  const now = Date.parse("2027-01-15T08:00:00.000Z");
  const id = "AAAAAAAAAAAAAAAB";
  const storage = new MemoryStorage();
  const finalized = toManagedTradeRecord(signedRecord({
    id,
    lifecycle: "finalized",
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), "a".repeat(43), "finalized");
  const racingFinalizing = toManagedTradeRecord(signedRecord({
    id,
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), "b".repeat(43), "finalizing");
  persistManagedTradeRecord(storage, finalized, "https://example.test", now);
  const storedBeforeRace = storage.getItem(managedTradeRecordStorageKey(id));

  assert.throws(
    () => persistManagedTradeRecord(storage, racingFinalizing, "https://example.test", now),
    /서로 다른 철회 권한/u,
  );
  assert.equal(storage.getItem(managedTradeRecordStorageKey(id)), storedBeforeRace);
  assert.equal(racingFinalizing.persistence, "memory-only");
  assert.equal(
    parsePersistedManagedTradeRecord(storedBeforeRace, "https://example.test", now).revokeToken,
    finalized.revokeToken,
  );
});

test("record-scoped browser storage preserves concurrent finalized capabilities without a count cap", () => {
  const now = Date.parse("2027-01-15T08:00:00.000Z");
  const storage = new MemoryStorage();
  const finalized = Array.from({ length: 40 }, (_unused, index) => {
    const id = String(index).padStart(16, "A");
    return toManagedTradeRecord(signedRecord({
      id,
      lifecycle: "finalized",
      verificationUrl: `https://example.test/verify/?id=${id}`,
    }), String(index).padStart(43, "a"), "finalized");
  });

  const persisted = finalized.map((record) => persistManagedTradeRecord(
    storage,
    record,
    "https://example.test",
    now,
  ));
  assert.equal(storage.length, 40);
  assert.deepEqual(
    loadPersistedManagedTradeRecords(storage, "https://example.test", now),
    persisted,
  );

  const unchanged = new Map(storage.values);
  assert.throws(
    () => loadPersistedManagedTradeRecords(storage, "not-an-origin", now),
    /origin/u,
  );
  assert.throws(
    () => loadPersistedManagedTradeRecords(storage, "https://example.test", Number.NaN),
    /시각/u,
  );
  assert.deepEqual(storage.values, unchanged);

  removePersistedManagedTradeRecord(storage, finalized[17].id);
  const remaining = loadPersistedManagedTradeRecords(storage, "https://example.test", now);
  assert.equal(remaining.length, 39);
  assert.equal(remaining.some((record) => record.id === finalized[17].id), false);
});

test("a corrupt record-scoped item cannot erase valid capabilities and legacy migration is lossless", () => {
  const now = Date.parse("2027-01-15T08:00:00.000Z");
  const firstId = "AAAAAAAAAAAAAAAB";
  const secondId = "AAAAAAAAAAAAAAAC";
  const records = [
    toManagedTradeRecord(signedRecord({
      id: firstId,
      lifecycle: "finalized",
      verificationUrl: `https://example.test/verify/?id=${firstId}`,
    }), "a".repeat(43), "finalized"),
    toManagedTradeRecord(signedRecord({
      id: secondId,
      lifecycle: "finalized",
      verificationUrl: `https://example.test/verify/?id=${secondId}`,
    }), "b".repeat(43), "finalized"),
  ];
  const storage = new MemoryStorage();
  const partiallyCorruptLegacy = JSON.parse(serializeManagedTradeRecords(records, now));
  partiallyCorruptLegacy.splice(1, 0, { invalid: true });
  storage.setItem(
    LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY,
    JSON.stringify(partiallyCorruptLegacy),
  );
  storage.setItem(managedTradeRecordStorageKey("AAAAAAAAAAAAAAAD"), "not-json");

  assert.deepEqual(
    loadPersistedManagedTradeRecords(storage, "https://example.test", now),
    records.map((record) => ({ ...record, persistence: "browser" })),
  );
  assert.equal(storage.getItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY), null);
  assert.equal(
    storage.getItem(managedTradeRecordStorageKey("AAAAAAAAAAAAAAAD")),
    "not-json",
    "hydration must not turn corruption into a cross-tab deletion event",
  );
  assert.notEqual(storage.getItem(managedTradeRecordStorageKey(firstId)), null);
  assert.notEqual(storage.getItem(managedTradeRecordStorageKey(secondId)), null);
});

test("failed legacy migration keeps its source snapshot and all capabilities available", () => {
  const now = Date.parse("2027-01-15T08:00:00.000Z");
  const id = "AAAAAAAAAAAAAAAB";
  const record = toManagedTradeRecord(signedRecord({
    id,
    lifecycle: "finalized",
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), "a".repeat(43), "finalized");
  const storage = new MemoryStorage();
  const legacy = serializeManagedTradeRecords([record], now);
  storage.setItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY, legacy);
  storage.failSetFor = managedTradeRecordStorageKey(id);

  assert.deepEqual(
    loadPersistedManagedTradeRecords(storage, "https://example.test", now),
    [{ ...record, persistence: "browser" }],
  );
  assert.equal(storage.getItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY), legacy);
});

test("a conflicting legacy capability never overwrites v2 and keeps its source for manual recovery", () => {
  const now = Date.parse("2027-01-15T08:00:00.000Z");
  const id = "AAAAAAAAAAAAAAAB";
  const current = toManagedTradeRecord(signedRecord({
    id,
    lifecycle: "finalized",
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), "a".repeat(43), "finalized");
  const staleLegacy = { ...current, revokeToken: "b".repeat(43) };
  const storage = new MemoryStorage();
  const persisted = persistManagedTradeRecord(storage, current, "https://example.test", now);
  storage.setItem(
    LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY,
    serializeManagedTradeRecords([staleLegacy], now),
  );

  assert.deepEqual(
    loadPersistedManagedTradeRecords(storage, "https://example.test", now),
    [persisted],
  );
  assert.equal(
    parsePersistedManagedTradeRecord(
      storage.getItem(managedTradeRecordStorageKey(id)),
      "https://example.test",
      now,
    ).revokeToken,
    current.revokeToken,
  );
  assert.notEqual(storage.getItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY), null);
});

test("a matching finalized legacy capability upgrades a lower-lifecycle v2 entry", () => {
  const now = Date.parse("2027-01-15T08:00:00.000Z");
  const id = "AAAAAAAAAAAAAAAB";
  const token = "a".repeat(43);
  const pending = toManagedTradeRecord(signedRecord({
    id,
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), token);
  const finalized = toManagedTradeRecord(signedRecord({
    id,
    lifecycle: "finalized",
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), token, "finalized");
  const storage = new MemoryStorage();
  persistManagedTradeRecord(storage, pending, "https://example.test", now);
  storage.setItem(
    LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY,
    serializeManagedTradeRecords([finalized], now),
  );

  const restored = loadPersistedManagedTradeRecords(storage, "https://example.test", now);
  assert.equal(restored[0].lifecycle, "finalized");
  assert.equal(
    parsePersistedManagedTradeRecord(
      storage.getItem(managedTradeRecordStorageKey(id)),
      "https://example.test",
      now,
    ).lifecycle,
    "finalized",
  );
  assert.equal(storage.getItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY), null);
});

test("an invalid or fully expired legacy snapshot is removed instead of retaining revoke tokens", () => {
  const now = Date.parse("2027-08-01T00:00:00.000Z");
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY, "not-json");
  assert.deepEqual(loadPersistedManagedTradeRecords(storage, "https://example.test", now), []);
  assert.equal(storage.getItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY), null);

  const id = "AAAAAAAAAAAAAAAB";
  const expired = toManagedTradeRecord(signedRecord({
    id,
    lifecycle: "finalized",
    verificationUrl: `https://example.test/verify/?id=${id}`,
  }), "a".repeat(43), "finalized");
  storage.setItem(
    LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY,
    serializeManagedTradeRecords([expired], Date.parse("2027-01-15T08:00:00.000Z")),
  );
  assert.deepEqual(loadPersistedManagedTradeRecords(storage, "https://example.test", now), []);
  assert.equal(storage.getItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY), null);
});
