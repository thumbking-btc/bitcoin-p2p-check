import assert from "node:assert/strict";
import test from "node:test";

import { buildTradePromotion } from "../app/lib/trade-promotion.mjs";

test("keeps the chosen amount exact and labels the market-converted side as approximate", () => {
  const krwBased = buildTradePromotion({
    tradeRole: "buyer",
    amountBasis: "krw",
    bitcoinDisplayUnit: "sats",
    paymentKrw: 500_000,
    sats: 550_000,
    sellerPremiumPercent: 2,
    transferSupport: "both",
  });
  assert.equal(krwBased.intent, "비트코인 500,000원어치 삽니다.");
  assert.equal(krwBased.approximate, "약 550,000 sats");
  assert.match(krwBased.text, /비트코인 500,000원어치 삽니다\.\n작성 당시 시세·프리미엄 반영: 약 550,000 sats/);
  assert.match(krwBased.text, /BTC 수령 가능 방식: 온체인 또는 라이트닝/);

  const bitcoinBased = buildTradePromotion({
    tradeRole: "seller",
    amountBasis: "bitcoin",
    bitcoinDisplayUnit: "btc",
    paymentKrw: 10_200_000,
    sats: 10_000_000,
    sellerPremiumPercent: 2,
    transferSupport: "lightning",
  });
  assert.equal(bitcoinBased.intent, "0.1 BTC 팝니다.");
  assert.equal(bitcoinBased.approximate, "약 10,200,000원");
  assert.match(bitcoinBased.text, /BTC 전송 가능 방식: 라이트닝/);
});

test("public promotion contains no funding source, payment identifier, or web link", () => {
  const promotion = buildTradePromotion({
    tradeRole: "buyer",
    amountBasis: "krw",
    bitcoinDisplayUnit: "btc",
    paymentKrw: 500_000,
    sats: 490_196,
    sellerPremiumPercent: 2,
    transferSupport: "onchain",
    fundingSource: "SENSITIVE_FUNDING",
    address: "bc1SENSITIVE",
    invoice: "lnbc1SENSITIVE",
    url: "https://sensitive.invalid",
  });
  assert.ok(promotion);
  assert.doesNotMatch(promotion.text, /SENSITIVE|bc1|lnbc1|https?:|자금 출처|bitcoin:/i);
  assert.match(promotion.text, /공개용/);
  assert.match(promotion.text, /실제 송금은 DM에서 한 방식으로 확정/);
});

test("rejects incomplete or invalid public promotion inputs", () => {
  const base = {
    tradeRole: "buyer",
    amountBasis: "krw",
    bitcoinDisplayUnit: "sats",
    paymentKrw: 500_000,
    sats: 490_196,
    sellerPremiumPercent: 2,
    transferSupport: "onchain",
  };
  assert.equal(buildTradePromotion({ ...base, sats: 0 }), null);
  assert.equal(buildTradePromotion({ ...base, paymentKrw: Number.NaN }), null);
  assert.equal(buildTradePromotion({ ...base, sellerPremiumPercent: -100 }), null);
  assert.equal(buildTradePromotion({ ...base, transferSupport: "automatic" }), null);
});
