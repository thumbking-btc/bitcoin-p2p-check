import assert from "node:assert/strict";
import test from "node:test";
import { MAX_KRW, MAX_SATS } from "../app/lib/p2p-quote.mjs";
import { buildBuyerContinuationFragment, parseTradeFragment } from "../app/lib/trade-link.mjs";

function sellerCondition(overrides = {}) {
  return {
    role: "seller",
    amountBasis: "krw",
    bitcoinDisplayUnit: "sats",
    paymentKrw: 1_000_000,
    sats: 1_025_641,
    referencePriceKrw: 100_000_000,
    marketObservedAt: "2026-09-29T00:00:00.000Z",
    koreaPremiumRatio: 0.02,
    sellerPremiumBps: -250,
    fundingSource: "근로소득",
    ...overrides,
  };
}

test("seller continuation keeps the chosen KRW input and discount, opening the buyer receive flow", () => {
  const fragment = buildBuyerContinuationFragment(sellerCondition());
  assert.equal(fragment, "#v=3&from=sell&basis=krw&krw=1000000&premium=-2.5&fund=none&unit=sats&receive=1");
  assert.deepEqual(parseTradeFragment(fragment), {
    side: "buy", creatorSide: "sell", amount: 1_000_000, amountBasis: "krw",
    premium: -2.5, fundingSource: "기재하지 않음", displayUnit: "sats", continueToReceive: true,
  });
  // The unselected BTC result and old market data must not lock the new quote.
  assert.equal(buildBuyerContinuationFragment(sellerCondition({ sats: 2_000_000, referencePriceKrw: 50_000_000 })), fragment);
});

test("seller continuation keeps the chosen sats input and BTC display independently of quoted KRW", () => {
  const condition = sellerCondition({ amountBasis: "bitcoin", bitcoinDisplayUnit: "btc", sats: 3_000_000, sellerPremiumBps: 125 });
  const fragment = buildBuyerContinuationFragment(condition);
  assert.equal(fragment, "#v=3&from=sell&basis=btc&sats=3000000&premium=1.25&fund=none&unit=btc&receive=1");
  assert.deepEqual(parseTradeFragment(fragment), {
    side: "buy", creatorSide: "sell", amount: 3_000_000, amountBasis: "bitcoin",
    premium: 1.25, fundingSource: "기재하지 않음", displayUnit: "btc", continueToReceive: true,
  });
  assert.equal(buildBuyerContinuationFragment({ ...condition, paymentKrw: 5_000_000 }), fragment);
});

test("continuation is deterministic in server and browser contexts and never copies private record fields", () => {
  const condition = Object.freeze(sellerCondition({
    id: "PRIVATE_RECORD_ID", address: "PRIVATE_ADDRESS", invoice: "PRIVATE_INVOICE",
    payload: "PRIVATE_PAYMENT", revokeToken: "PRIVATE_CAPABILITY", verificationUrl: "https://private.invalid/",
  }));
  const before = structuredClone(condition);
  const fragment = buildBuyerContinuationFragment(condition);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    assert.equal(buildBuyerContinuationFragment(condition), fragment);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  }
  assert.deepEqual(condition, before);
  const params = new URLSearchParams(fragment.slice(1));
  assert.deepEqual([...params.keys()], ["v", "from", "basis", "krw", "premium", "fund", "unit", "receive"]);
  assert.equal(params.get("fund"), "none");
  assert.doesNotMatch(decodeURIComponent(fragment), /PRIVATE|근로소득|referencePriceKrw|marketObservedAt|koreaPremiumRatio|verificationUrl|revokeToken/);
});

test("continuation builder rejects invalid conditions and number coercion", () => {
  for (const invalid of [null, undefined, [], "seller", 1, true, {}, { role: "seller" }]) {
    assert.equal(buildBuyerContinuationFragment(invalid), "");
  }
  for (const fields of [
    { role: "buyer" }, { role: "sell" }, { amountBasis: "btc" }, { amountBasis: null },
    { bitcoinDisplayUnit: "krw" }, { bitcoinDisplayUnit: undefined },
    { paymentKrw: 0 }, { paymentKrw: -1 }, { paymentKrw: 0.5 }, { paymentKrw: "1000000" },
    { paymentKrw: MAX_KRW + 1 }, { paymentKrw: Number.NaN }, { paymentKrw: Infinity },
    { sats: 0 }, { sats: -1 }, { sats: 1.5 }, { sats: "1000000" }, { sats: MAX_SATS + 1 },
    { sats: Number.MAX_SAFE_INTEGER + 1 }, { sats: Number.NaN }, { sats: Infinity },
    { sellerPremiumBps: -10_000 }, { sellerPremiumBps: 100_000 }, { sellerPremiumBps: 0.5 },
    { sellerPremiumBps: "125" }, { sellerPremiumBps: Number.NaN }, { sellerPremiumBps: Infinity },
  ]) {
    assert.equal(buildBuyerContinuationFragment(sellerCondition(fields)), "", JSON.stringify(fields));
  }
});

test("continuation builder accepts exact integer and premium boundaries", () => {
  for (const fields of [
    { paymentKrw: 1, sats: 1, sellerPremiumBps: -9_999 },
    { paymentKrw: MAX_KRW, sats: MAX_SATS, sellerPremiumBps: 99_999 },
    { amountBasis: "bitcoin", paymentKrw: MAX_KRW, sats: MAX_SATS, sellerPremiumBps: 0 },
  ]) {
    const condition = sellerCondition(fields);
    const parsed = parseTradeFragment(buildBuyerContinuationFragment(condition));
    assert.ok(parsed);
    assert.equal(parsed.amount, condition.amountBasis === "krw" ? condition.paymentKrw : condition.sats);
    assert.equal(parsed.premium, condition.sellerPremiumBps / 100);
    assert.equal(parsed.continueToReceive, true);
  }
});

test("receive marker is accepted only once with value 1 on seller-created v3 links", () => {
  const prefix = "#v=3&from=sell&basis=krw&krw=1000000&premium=0&fund=none&unit=sats";
  for (const marker of ["receive=", "receive=0", "receive=2", "receive=true", "receive=01", "receive=1&receive=1", "receive=1&rece%69ve=1"]) {
    assert.equal(parseTradeFragment(`${prefix}&${marker}`), null, marker);
  }
  for (const invalid of [
    "#v=1&side=sell&sats=1000000&premium=0&receive=1",
    "#v=2&side=sell&basis=krw&krw=1000000&premium=0&receive=1",
    "#v=3&from=buy&basis=krw&krw=1000000&premium=0&receive=1",
    `${prefix}&receive=1&sats=1000000`, `${prefix}&receive=1&basis=krw`,
  ]) assert.equal(parseTradeFragment(invalid), null);
  assert.equal(parseTradeFragment(`${prefix}&receive=1`)?.continueToReceive, true);
  assert.equal(parseTradeFragment("#v=3&from=sell&basis=krw&krw=1000000&premium=0&receive=1")?.fundingSource, "기재하지 않음");
});

test("marked links reject funding and hidden record data instead of importing them into a buyer draft", () => {
  const prefix = "#v=3&from=sell&basis=btc&sats=1000000&premium=0&unit=btc&receive=1";
  for (const field of [
    "fund=salary", "address=PRIVATE_ADDRESS", "invoice=PRIVATE_INVOICE", "id=PRIVATE_RECORD_ID",
    "revokeToken=PRIVATE_CAPABILITY", "referencePriceKrw=100000000", "marketObservedAt=old", "extra=1",
  ]) assert.equal(parseTradeFragment(`${prefix}&${field}`), null, field);
});

test("unmarked legacy v1 v2 and v3 links keep their original parsing shapes and unknown-key compatibility", () => {
  const base = { amount: 1_000_000, amountBasis: "krw", premium: 2, fundingSource: "근로소득", displayUnit: "sats" };
  assert.deepEqual(parseTradeFragment("#v=1&side=buy&krw=1000000&premium=2&fund=salary&extra=1"), { side: "buy", ...base });
  assert.deepEqual(parseTradeFragment("#v=2&side=sell&basis=krw&krw=1000000&premium=2&fund=salary&extra=1"), { side: "sell", ...base });
  assert.deepEqual(parseTradeFragment("#v=3&from=sell&basis=krw&krw=1000000&premium=2&fund=salary&extra=1"), { side: "buy", ...base, creatorSide: "sell" });
  assert.deepEqual(parseTradeFragment("#v=3&from=buy&basis=krw&krw=1000000&premium=2&fund=salary&extra=1"), { side: "sell", ...base, creatorSide: "buy" });
});
