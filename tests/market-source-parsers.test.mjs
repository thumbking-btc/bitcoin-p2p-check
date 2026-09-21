import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFeePayload,
  parsePremiumPayload,
  parsePricePayload,
} from "../worker/market-source-parsers.ts";

const RETRIEVED_AT = "2026-08-26T01:02:03.000Z";
const NOW_MS = Date.parse("2026-08-26T01:02:03.000Z");
const INVALID = { ok: false, failure: "invalid" };

test("price parsing normalizes numeric fields and preserves observation timestamps", () => {
  const observedAt = NOW_MS - 90_000;

  assert.deepEqual(
    parsePricePayload([{
      trade_price: "100000000",
      trade_timestamp: String(observedAt),
    }], NOW_MS, RETRIEVED_AT),
    {
      ok: true,
      value: {
        priceKrw: 100_000_000,
        priceObservedAt: new Date(observedAt).toISOString(),
        retrievedAt: RETRIEVED_AT,
      },
    },
  );
});

test("price parsing keeps the two-minute age and thirty-second clock-skew boundaries", () => {
  for (const observedAt of [NOW_MS - 120_000, NOW_MS + 30_000]) {
    assert.equal(parsePricePayload([{
      trade_price: 100_000_000,
      trade_timestamp: observedAt,
    }], NOW_MS, RETRIEVED_AT).ok, true);
  }

  for (const observedAt of [NOW_MS - 120_001, NOW_MS + 30_001]) {
    assert.deepEqual(parsePricePayload([{
      trade_price: 100_000_000,
      trade_timestamp: observedAt,
    }], NOW_MS, RETRIEVED_AT), INVALID);
  }

  assert.deepEqual(
    parsePricePayload([{ trade_price: 0, trade_timestamp: NOW_MS }], NOW_MS, RETRIEVED_AT),
    INVALID,
  );
  assert.deepEqual(parsePricePayload({}, NOW_MS, RETRIEVED_AT), INVALID);
});

test("premium parsing selects the Bitcoin record and converts percent to a ratio", () => {
  assert.deepEqual(parsePremiumPayload({
    data: {
      records: [
        { code: "CRIX.UPBIT.KRW-ETH", disparityRate: 2 },
        { pair: "BTC/KRW", disparityRate: "12.5" },
      ],
    },
  }, RETRIEVED_AT), {
    ok: true,
    value: { koreaPremium: 0.125, retrievedAt: RETRIEVED_AT },
  });

  for (const disparityRate of [-50, 50]) {
    assert.equal(parsePremiumPayload({
      data: { records: [{ code: "CRIX.UPBIT.KRW-BTC", disparityRate }] },
    }, RETRIEVED_AT).ok, true);
  }

  assert.deepEqual(parsePremiumPayload({
    data: { records: [{ code: "CRIX.UPBIT.KRW-BTC", disparityRate: 50.000_001 }] },
  }, RETRIEVED_AT), INVALID);
  assert.deepEqual(parsePremiumPayload({ data: { records: [] } }, RETRIEVED_AT), INVALID);
});

test("fee parsing requires bounded monotonic tiers and exposes the three public rates", () => {
  assert.deepEqual(parseFeePayload({
    fastestFee: "25",
    halfHourFee: 20,
    hourFee: 15,
    economyFee: 10,
    minimumFee: 5,
  }, RETRIEVED_AT), {
    ok: true,
    value: {
      feeRates: { nextBlock: 25, halfHour: 20, hour: 15 },
      retrievedAt: RETRIEVED_AT,
    },
  });

  for (const payload of [
    { fastestFee: 20, halfHourFee: 25, hourFee: 15, economyFee: 10, minimumFee: 5 },
    { fastestFee: 10_001, halfHourFee: 20, hourFee: 15, economyFee: 10, minimumFee: 5 },
    { fastestFee: 25, halfHourFee: 20, hourFee: 15, economyFee: 10 },
    { fastestFee: 25, halfHourFee: 20, hourFee: 15, economyFee: 0, minimumFee: 0 },
  ]) {
    assert.deepEqual(parseFeePayload(payload, RETRIEVED_AT), INVALID);
  }
});
