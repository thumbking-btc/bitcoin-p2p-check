import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateP2PQuote,
  isSupportedPremiumPercent,
  MAX_PREMIUM_PERCENT,
  MAX_SATS,
  MIN_PREMIUM_PERCENT,
  stepPremiumPercent,
} from "../app/lib/p2p-quote.mjs";

test("calculates both quote directions with exact half-up rounding", () => {
  assert.deepEqual(
    calculateP2PQuote({
      mode: "krw",
      amount: 1_020_000,
      referencePrice: 100_000_000,
      premiumPercent: 2,
    }),
    {
      referencePrice: 100_000_000,
      appliedPrice: 102_000_000,
      premiumPercent: 2,
      paymentKrw: 1_020_000,
      sats: 1_000_000,
    },
  );

  assert.equal(calculateP2PQuote({
    mode: "sats",
    amount: 3_000_000,
    referencePrice: 100_000_000,
    premiumPercent: 2,
  })?.paymentKrw, 3_060_000);

  assert.equal(calculateP2PQuote({
    mode: "krw",
    amount: 1,
    referencePrice: 200_000_000,
    premiumPercent: 0,
  })?.sats, 1, "exactly half a sat rounds up");

  assert.equal(calculateP2PQuote({
    mode: "sats",
    amount: 1,
    referencePrice: 50_000_000,
    premiumPercent: 0,
  })?.paymentKrw, 1, "exactly half a won rounds up");
});

test("does not lose a sat on a large valid quote", () => {
  const quote = calculateP2PQuote({
    mode: "krw",
    amount: 549_106_779_095,
    referencePrice: 142_930_846,
    premiumPercent: -98.83,
  });

  assert.equal(quote?.sats, 32_835_601_729_702);
  assert.equal(quote?.paymentKrw, 549_106_779_095);
});

test("rejects coerced, fractional, non-finite, and malformed quote inputs", () => {
  const valid = {
    mode: "krw",
    amount: 3_000_000,
    referencePrice: 100_000_000,
    premiumPercent: 2,
  };

  assert.equal(calculateP2PQuote(null), null);
  assert.equal(calculateP2PQuote([]), null);
  assert.equal(calculateP2PQuote({ ...valid, mode: "btc" }), null);
  assert.equal(calculateP2PQuote({ ...valid, amount: "3000000" }), null);
  assert.equal(calculateP2PQuote({ ...valid, referencePrice: "100000000" }), null);
  assert.equal(calculateP2PQuote({ ...valid, premiumPercent: "2" }), null);
  assert.equal(calculateP2PQuote({ ...valid, amount: 3_000_000.5 }), null);
  assert.equal(calculateP2PQuote({ ...valid, referencePrice: 100_000_000.5 }), null);
  assert.equal(calculateP2PQuote({ ...valid, premiumPercent: 2.001 }), null);
  assert.equal(calculateP2PQuote({ ...valid, premiumPercent: Number.POSITIVE_INFINITY }), null);
  assert.equal(calculateP2PQuote({ ...valid, amount: Number.MAX_SAFE_INTEGER + 1 }), null);
});

test("uses one bounded two-decimal premium contract", () => {
  assert.equal(MIN_PREMIUM_PERCENT, -99.99);
  assert.equal(MAX_PREMIUM_PERCENT, 999.99);
  assert.equal(isSupportedPremiumPercent(MIN_PREMIUM_PERCENT), true);
  assert.equal(isSupportedPremiumPercent(MAX_PREMIUM_PERCENT), true);
  assert.equal(isSupportedPremiumPercent(-100), false);
  assert.equal(isSupportedPremiumPercent(1_000), false);
  assert.equal(isSupportedPremiumPercent(0.001), false);

  assert.equal(calculateP2PQuote({
    mode: "krw",
    amount: 1,
    referencePrice: 100_000_000,
    premiumPercent: MIN_PREMIUM_PERCENT,
  })?.sats, 10_000);
  assert.equal(calculateP2PQuote({
    mode: "krw",
    amount: 1_099_990_000,
    referencePrice: 100_000_000,
    premiumPercent: MAX_PREMIUM_PERCENT,
  })?.sats, 100_000_000);
});

test("steps the premium by one tenth of a percent and clamps at supported boundaries", () => {
  assert.equal(stepPremiumPercent(2, 1), 2.1);
  assert.equal(stepPremiumPercent(2, -1), 1.9);
  assert.equal(stepPremiumPercent(null, 1), 0.1);
  assert.equal(stepPremiumPercent(null, -1), -0.1);
  assert.equal(stepPremiumPercent(MAX_PREMIUM_PERCENT, 1), MAX_PREMIUM_PERCENT);
  assert.equal(stepPremiumPercent(MIN_PREMIUM_PERCENT, -1), MIN_PREMIUM_PERCENT);
  assert.equal(stepPremiumPercent(1_000, -1), 999.9);
  assert.equal(stepPremiumPercent(-100, 1), -99.9);
  assert.equal(stepPremiumPercent(2.001, 1), null);
  assert.equal(stepPremiumPercent(2, 0), null);
});

test("fails closed when a rounded result is zero or exceeds its domain", () => {
  assert.equal(calculateP2PQuote({
    mode: "krw",
    amount: 1,
    referencePrice: Number.MAX_SAFE_INTEGER,
    premiumPercent: MAX_PREMIUM_PERCENT,
  }), null);
  assert.equal(calculateP2PQuote({
    mode: "krw",
    amount: Number.MAX_SAFE_INTEGER,
    referencePrice: 1,
    premiumPercent: MIN_PREMIUM_PERCENT,
  }), null);
  assert.equal(calculateP2PQuote({
    mode: "sats",
    amount: MAX_SATS + 1,
    referencePrice: 100_000_000,
    premiumPercent: 0,
  }), null);
});
