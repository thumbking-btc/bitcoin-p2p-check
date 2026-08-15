import assert from "node:assert/strict";
import test from "node:test";

import {
  TRADE_DRAFT_STORAGE_KEY,
  TRADE_DRAFT_VERSION,
  readTradeDraft,
  validateTradeDraft,
  writeTradeDraft,
} from "../app/lib/trade-draft.mjs";

const NOW = 1_800_000_000_000;

function createFields() {
  return {
    tradeRole: "buyer",
    krwAmounts: { buyer: "500000", seller: "800000" },
    bitcoinAmountInputs: { buyer: "0.005", seller: "0.008" },
    amountBasisByRole: { buyer: "krw", seller: "bitcoin" },
    premiumInput: "2.5",
    fundingSources: { buyer: "근로소득", seller: "기재하지 않음" },
    bitcoinDisplayUnit: "btc",
    transferSupportByRole: { buyer: "both", seller: "lightning" },
  };
}

function createStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set(TRADE_DRAFT_STORAGE_KEY, initialValue);
  const removed = [];
  return {
    removed,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => {
        removed.push(key);
        values.delete(key);
      },
    },
    values,
  };
}

function createLegacyDraft() {
  const fields = createFields();
  delete fields.transferSupportByRole;
  return {
    version: 1,
    savedAt: NOW,
    ...fields,
  };
}

test("writes the v2 role-scoped transfer support through the strict allowlist", () => {
  const { storage, values } = createStorage();
  const fields = {
    ...createFields(),
    address: "bc1qmust-not-be-persisted",
    invoice: "lnbcmust-not-be-persisted",
    market: { priceKrw: 100_000_000 },
  };

  assert.equal(TRADE_DRAFT_VERSION, 2);
  assert.equal(writeTradeDraft(storage, fields, NOW), true);
  const stored = JSON.parse(values.get(TRADE_DRAFT_STORAGE_KEY));
  assert.deepEqual(Object.keys(stored).sort(), [
    "amountBasisByRole",
    "bitcoinAmountInputs",
    "bitcoinDisplayUnit",
    "fundingSources",
    "krwAmounts",
    "premiumInput",
    "savedAt",
    "tradeRole",
    "transferSupportByRole",
    "version",
  ]);
  assert.deepEqual(stored.transferSupportByRole, { buyer: "both", seller: "lightning" });
  assert.equal(Object.hasOwn(stored, "address"), false);
  assert.equal(Object.hasOwn(stored, "invoice"), false);
  assert.equal(Object.hasOwn(stored, "market"), false);
});

test("migrates an exact v1 draft to onchain defaults without deleting its inputs", () => {
  const legacy = createLegacyDraft();
  const expected = {
    ...legacy,
    version: TRADE_DRAFT_VERSION,
    transferSupportByRole: { buyer: "onchain", seller: "onchain" },
  };

  assert.deepEqual(validateTradeDraft(legacy, NOW), expected);

  const { storage, values, removed } = createStorage(JSON.stringify(legacy));
  assert.deepEqual(readTradeDraft(storage, NOW), expected);
  assert.deepEqual(removed, []);
  assert.deepEqual(JSON.parse(values.get(TRADE_DRAFT_STORAGE_KEY)), expected);

  const readOnlyStorage = {
    getItem: () => JSON.stringify(legacy),
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("must not delete a valid legacy draft"); },
  };
  assert.deepEqual(readTradeDraft(readOnlyStorage, NOW), expected);
});

test("rejects altered legacy shapes and invalid v2 transfer support", () => {
  const legacy = createLegacyDraft();
  const validV2 = {
    ...createFields(),
    version: TRADE_DRAFT_VERSION,
    savedAt: NOW,
  };

  assert.equal(validateTradeDraft({ ...legacy, extra: true }, NOW), null);
  assert.equal(validateTradeDraft({ ...legacy, transferSupportByRole: { buyer: "onchain", seller: "onchain" } }, NOW), null);
  assert.equal(validateTradeDraft({ ...validV2, transferSupportByRole: undefined }, NOW), null);
  assert.equal(validateTradeDraft({ ...validV2, transferSupportByRole: { buyer: "auto", seller: "onchain" } }, NOW), null);
  assert.equal(validateTradeDraft({ ...validV2, transferSupportByRole: { buyer: "onchain", seller: "both", extra: "lightning" } }, NOW), null);
  assert.equal(validateTradeDraft({ ...validV2, version: 3 }, NOW), null);
});
