import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { calculateP2PQuote, MAX_SATS, stepPremiumPercent } from "../app/lib/p2p-quote.mjs";
import { groupedBtcInput, normalizeBtcInput, parseBitcoinAmount, satsToBtcInput } from "../app/lib/bitcoin-amount.mjs";
import { isReferenceShareable, shareImageFile } from "../app/lib/share-transport.mjs";
import { buildTradeIntent, getTradeRecipientLabel } from "../app/lib/trade-share-copy.mjs";
import { buildTradeFragment, parseTradeFragment } from "../app/lib/trade-link.mjs";
import { getMarketRefreshDelay, MARKET_REFRESH_INTERVAL_MS } from "../app/lib/market-refresh.mjs";
import {
  buildTradeRecruitmentPost,
  copyTradeRecruitmentText,
  syncTradeRecruitmentPreview,
} from "../app/lib/trade-recruitment.mjs";
import {
  readTradeDraft,
  TRADE_DRAFT_MAX_RAW_LENGTH,
  TRADE_DRAFT_STORAGE_KEY,
  TRADE_DRAFT_TTL_MS,
  TRADE_DRAFT_VERSION,
  validateTradeDraft,
  writeTradeDraft,
} from "../app/lib/trade-draft.mjs";
import {
  getInstallInviteDismissedUntil,
  INSTALL_INVITE_DISMISS_MS,
  isInstallInviteSuppressed,
} from "../app/lib/install-invite.mjs";

async function readPngSize(url) {
  const buffer = await readFile(url);
  assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function render(pathname = "/") {
  const relativePath = pathname === "/"
    ? "../dist/client/index.html"
    : `../dist/client${pathname.replace(/\/$/, "")}/index.html`;
  const html = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

test("calculates buyer and seller quotes without hiding fees", () => {
  const buyer = calculateP2PQuote({ mode: "krw", amount: 3_000_000, referencePrice: 100_000_000, premiumPercent: 2 });
  assert.ok(buyer);
  assert.equal(buyer.appliedPrice, 102_000_000);
  assert.equal(buyer.paymentKrw, 3_000_000);
  assert.equal(buyer.sats, 2_941_176);

  const seller = calculateP2PQuote({ mode: "sats", amount: 3_000_000, referencePrice: 100_000_000, premiumPercent: 2 });
  assert.ok(seller);
  assert.equal(seller.sats, 3_000_000);
  assert.equal(seller.paymentKrw, 3_060_000);

  const buyerDiscount = calculateP2PQuote({ mode: "krw", amount: 3_000_000, referencePrice: 100_000_000, premiumPercent: -2 });
  assert.equal(buyerDiscount?.sats, 3_061_224);
  const sellerDiscount = calculateP2PQuote({ mode: "sats", amount: 3_000_000, referencePrice: 100_000_000, premiumPercent: -2 });
  assert.equal(sellerDiscount?.paymentKrw, 2_940_000);
});

test("steps seller premium controls by one tenth of a percent", () => {
  assert.equal(stepPremiumPercent(2, 1), 2.1);
  assert.equal(stepPremiumPercent(2, -1), 1.9);
  assert.equal(stepPremiumPercent(null, 1), 0.1);
  assert.equal(stepPremiumPercent(null, -1), -0.1);
  assert.equal(stepPremiumPercent(-99.99, -1), -99.99);
  assert.equal(stepPremiumPercent(2.001, 1), null);
  assert.equal(stepPremiumPercent(2, 0), null);
});

test("converts the bitcoin input between sats and BTC without changing its value", () => {
  for (const [sats, btc] of [
    [1, "0.00000001"],
    [3_000_000, "0.03"],
    [10_000_000, "0.1"],
    [123_456_789, "1.23456789"],
    [MAX_SATS, "21000000"],
  ]) {
    assert.equal(satsToBtcInput(sats), btc);
    assert.deepEqual(parseBitcoinAmount(btc, "btc"), { sats, error: null });
    assert.deepEqual(parseBitcoinAmount(String(sats), "sats"), { sats, error: null });
  }

  assert.equal(groupedBtcInput("21000000.00000001"), "21,000,000.00000001");
  assert.equal(normalizeBtcInput("0.10000000"), "0.10000000");
  assert.equal(normalizeBtcInput("1e-8"), null);
  assert.deepEqual(parseBitcoinAmount("0.000000001", "btc"), { sats: null, error: "precision" });
  assert.deepEqual(parseBitcoinAmount("21000000.00000001", "btc"), { sats: null, error: "range" });
  assert.deepEqual(parseBitcoinAmount("-0.1", "btc"), { sats: null, error: "format" });

  const quote = calculateP2PQuote({
    mode: "sats",
    amount: parseBitcoinAmount("0.1", "btc").sats,
    referencePrice: 100_000_000,
    premiumPercent: 2,
  });
  assert.equal(quote?.paymentKrw, 10_200_000);

  const krwBasisQuote = calculateP2PQuote({
    mode: "krw",
    amount: 500_000,
    referencePrice: 100_000_000,
    premiumPercent: 2,
  });
  assert.equal(krwBasisQuote?.paymentKrw, 500_000);
  assert.equal(krwBasisQuote?.sats, 490_196);
});

test("writes a natural buy or sell sentence at the start of a share", () => {
  assert.equal(
    buildTradeIntent({ tradeRole: "buyer", paymentKrw: 10_000, sats: 10_000 }),
    "비트코인 10,000원어치 삽니다.",
  );
  assert.equal(
    buildTradeIntent({ tradeRole: "buyer", amountBasis: "bitcoin", paymentKrw: 10_200_000, sats: 10_000_000, bitcoinDisplayUnit: "btc" }),
    "0.1 BTC 삽니다.",
  );
  assert.equal(
    buildTradeIntent({ tradeRole: "buyer", amountBasis: "bitcoin", paymentKrw: 10_200_000, sats: 10_000_000, bitcoinDisplayUnit: "sats" }),
    "10,000,000 sats 삽니다.",
  );
  assert.equal(
    buildTradeIntent({ tradeRole: "seller", amountBasis: "krw", paymentKrw: 500_000, sats: 490_196, bitcoinDisplayUnit: "btc" }),
    "500,000원어치 BTC 팝니다.",
  );
  assert.equal(
    buildTradeIntent({ tradeRole: "seller", paymentKrw: 10_000, sats: 10_000_000, bitcoinDisplayUnit: "btc" }),
    "0.1 BTC 팝니다.",
  );
  assert.equal(
    buildTradeIntent({ tradeRole: "seller", paymentKrw: 10_000, sats: 1, bitcoinDisplayUnit: "btc" }),
    "0.00000001 BTC 팝니다.",
  );
  assert.equal(
    buildTradeIntent({ tradeRole: "seller", paymentKrw: 10_000, sats: 10_000_000, bitcoinDisplayUnit: "sats" }),
    "10,000,000 sats 팝니다.",
  );
  assert.equal(getTradeRecipientLabel("buyer"), "구매자가 받음");
  assert.equal(getTradeRecipientLabel("seller"), "판매자가 받음");
});

test("builds compact public recruitment posts with exact intent and rounded equivalents", () => {
  assert.deepEqual(buildTradeRecruitmentPost({
    tradeRole: "buyer",
    amountUnit: "krw",
    amountInput: "1000000",
    sellerPremiumInput: "3",
    approximateSats: 917_345,
    bitcoinDisplayUnit: "sats",
    network: "both",
    canShareKrwSource: true,
    canVerifyIdentity: true,
  }), {
    text: "구매 / 100만원 (약 91.7만 sats) / 3% / 온체인·라이트닝\n원화 출처 설명과 상호 신원확인 협의 가능합니다.\nDM 부탁드립니다.",
    error: "",
  });

  assert.match(buildTradeRecruitmentPost({
    tradeRole: "buyer",
    amountUnit: "krw",
    amountInput: "1000000",
    sellerPremiumInput: "3",
    approximateSats: 917_345,
    bitcoinDisplayUnit: "btc",
    network: "onchain",
  }).text, /100만원 \(약 0\.00917 BTC\)/);

  assert.deepEqual(buildTradeRecruitmentPost({
    tradeRole: "seller",
    amountUnit: "sats",
    amountInput: "3000000",
    sellerPremiumInput: "3",
    approximateKrw: 3_271_234,
    network: "lightning",
    returningTraderEnabled: true,
    returningTraderPremiumInput: "2.5",
    memo: "첫 거래자는 활동 내역을 확인합니다.\n답변이 늦을 수 있습니다.",
  }), {
    text: "판매 / 300만 sats (약 327만원) / 3% (기존 거래자 2.5%) / 라이트닝\n첫 거래자는 활동 내역을 확인합니다.\n답변이 늦을 수 있습니다.\nDM 부탁드립니다.",
    error: "",
  });

  assert.equal(buildTradeRecruitmentPost({
    tradeRole: "buyer",
    amountUnit: "btc",
    amountInput: "0.10000000",
    sellerPremiumInput: "2",
    approximateKrw: 10_923_456,
    network: "onchain",
  }).text, "구매 / 0.1 BTC (약 1,090만원) / 2% / 온체인\nDM 부탁드립니다.");
  assert.equal(buildTradeRecruitmentPost({
    tradeRole: "buyer",
    amountUnit: "btc",
    amountInput: "0.00000001",
    sellerPremiumInput: "2",
    network: "onchain",
  }).text, "구매 / 0.00000001 BTC / 2% / 온체인\nDM 부탁드립니다.");
});

test("validates recruitment discounts and excludes settlement-only details", () => {
  const base = {
    tradeRole: "buyer",
    amountUnit: "krw",
    amountInput: "1234567",
    sellerPremiumInput: "3",
    network: "onchain",
  };
  assert.match(buildTradeRecruitmentPost({ ...base, amountInput: "0" }).error, /0보다/);
  assert.match(buildTradeRecruitmentPost({ ...base, amountUnit: "btc", amountInput: "0.000000001" }).error, /8자리/);
  assert.match(buildTradeRecruitmentPost({ ...base, sellerPremiumInput: "-100" }).error, /-100%/);
  assert.match(buildTradeRecruitmentPost({ ...base, sellerPremiumInput: "-0" }).text, /\/ 0% \//);
  assert.match(buildTradeRecruitmentPost({ ...base, returningTraderEnabled: true, returningTraderPremiumInput: "" }).error, /우대 프리미엄/);
  assert.match(buildTradeRecruitmentPost({ ...base, returningTraderEnabled: true, returningTraderPremiumInput: "3" }).error, /낮아야/);
  assert.match(buildTradeRecruitmentPost({ ...base, returningTraderEnabled: true, returningTraderPremiumInput: "3.5" }).error, /낮아야/);

  for (const [network, label] of [["onchain", "온체인"], ["lightning", "라이트닝"], ["both", "온체인·라이트닝"]]) {
    assert.match(buildTradeRecruitmentPost({ ...base, network }).text, new RegExp(`${label}\\nDM 부탁드립니다\\.$`));
  }

  const publicPost = buildTradeRecruitmentPost({
    ...base,
    fundingSource: "근로소득",
    address: "bc1qexample",
    invoice: "lnbc1example",
    qr: "secret",
    paymentRequest: "secret",
  }).text;
  assert.equal(publicPost, "구매 / 1,234,567원 / 3% / 온체인\nDM 부탁드립니다.");
  assert.doesNotMatch(publicPost, /근로소득|bc1|lnbc|주소|인보이스|QR|지급 ?요청|업비트|계산 시각|구매자 → 판매자|온체인 수수료/);

  const sellerPost = buildTradeRecruitmentPost({
    ...base,
    tradeRole: "seller",
    canShareKrwSource: true,
    canVerifyIdentity: true,
  }).text;
  assert.equal(sellerPost, "판매 / 1,234,567원 / 3% / 온체인\n상호 신원확인 협의 가능합니다.\nDM 부탁드립니다.");
  assert.doesNotMatch(sellerPost, /원화 출처/);
});

test("preserves edited recruitment previews and copies the exact visible text", async () => {
  const previousGenerated = "구매 / 100만원 / 3% / 온체인\nDM 부탁드립니다.";
  const nextGenerated = "구매 / 100만원 / 3% / 라이트닝\nDM 부탁드립니다.";
  assert.deepEqual(syncTradeRecruitmentPreview({
    preview: previousGenerated,
    previousGenerated,
    nextGenerated,
  }), { preview: nextGenerated, dirty: false });
  assert.deepEqual(syncTradeRecruitmentPreview({
    preview: "직접 편집한 모집글",
    previousGenerated,
    nextGenerated: previousGenerated,
  }), { preview: "직접 편집한 모집글", dirty: true });
  assert.deepEqual(syncTradeRecruitmentPreview({
    preview: "직접 편집한 모집글",
    previousGenerated,
    nextGenerated,
  }), { preview: "직접 편집한 모집글", dirty: true });
  assert.deepEqual(syncTradeRecruitmentPreview({
    preview: "직접 편집한 모집글",
    previousGenerated,
    nextGenerated,
    force: true,
  }), { preview: nextGenerated, dirty: false });

  const edited = "  편집한 모집글\n그대로  ";
  let clipboardValue = "";
  assert.equal(await copyTradeRecruitmentText(edited, async (value) => { clipboardValue = value; }), "copied");
  assert.equal(clipboardValue, edited);

  let fallbackValue = "";
  assert.equal(await copyTradeRecruitmentText(
    edited,
    async () => { throw new Error("blocked"); },
    (value) => { fallbackValue = value; return true; },
  ), "copied");
  assert.equal(fallbackValue, edited);
  assert.equal(await copyTradeRecruitmentText("   ", null, null), "empty");
});

test("suppresses a dismissed install invitation for one day", () => {
  const now = 1_800_000_000_000;
  const dismissedUntil = getInstallInviteDismissedUntil(now);
  assert.equal(dismissedUntil, now + INSTALL_INVITE_DISMISS_MS);
  assert.equal(isInstallInviteSuppressed(String(dismissedUntil), now), true);
  assert.equal(isInstallInviteSuppressed(String(dismissedUntil), dismissedUntil), false);
  assert.equal(isInstallInviteSuppressed("invalid", now), false);
  assert.equal(isInstallInviteSuppressed(null, now), false);
});

test("rejects invalid, zero-result, non-finite, and out-of-range quotes", () => {
  assert.equal(calculateP2PQuote({ mode: "krw", amount: 0, referencePrice: 100_000_000, premiumPercent: 2 }), null);
  assert.equal(calculateP2PQuote({ mode: "krw", amount: 1, referencePrice: 100_000_000, premiumPercent: -100 }), null);
  assert.equal(calculateP2PQuote({ mode: "krw", amount: 1, referencePrice: 100_000_000, premiumPercent: Infinity }), null);
  assert.equal(calculateP2PQuote({ mode: "krw", amount: 0.1, referencePrice: 100_000_000, premiumPercent: 0 }), null);
  assert.equal(calculateP2PQuote({ mode: "sats", amount: MAX_SATS + 1, referencePrice: 100_000_000, premiumPercent: 0 }), null);
});

test("shares a PNG file and downloads only when file sharing is unavailable", async () => {
  const file = { name: "bitcoin-p2p-trade.png", type: "image/png" };
  let sharedPayload = null;
  const downloaded = [];

  const shared = await shareImageFile({
    file,
    title: "비트코인 P2P 거래 조건",
    text: "거래 조건",
    nativeCanShare: (data) => data.files?.[0] === file,
    nativeShare: async (data) => { sharedPayload = data; },
    download: (value) => downloaded.push(value),
  });
  assert.equal(shared, "shared");
  assert.equal(sharedPayload.files[0], file);
  assert.equal(downloaded.length, 0);

  const unsupported = await shareImageFile({
    file,
    title: "비트코인 P2P 거래 조건",
    text: "거래 조건",
    nativeCanShare: () => false,
    nativeShare: async () => { throw new Error("must not run"); },
    download: (value) => downloaded.push(value),
  });
  assert.equal(unsupported, "downloaded");
  assert.equal(downloaded.length, 1);

  const abortError = new Error("cancelled");
  abortError.name = "AbortError";
  const cancelled = await shareImageFile({
    file,
    title: "비트코인 P2P 거래 조건",
    text: "거래 조건",
    nativeCanShare: () => true,
    nativeShare: async () => { throw abortError; },
    download: (value) => downloaded.push(value),
  });
  assert.equal(cancelled, "cancelled");
  assert.equal(downloaded.length, 1);

  const recovered = await shareImageFile({
    file,
    title: "비트코인 P2P 거래 조건",
    text: "거래 조건",
    nativeCanShare: () => true,
    nativeShare: async () => { throw new Error("share failed"); },
    download: (value) => downloaded.push(value),
  });
  assert.equal(recovered, "downloaded-after-error");
  assert.equal(downloaded.length, 2);
});

test("blocks stale or loading Upbit references", () => {
  const observedAt = "2026-08-11T00:00:00.000Z";
  const base = Date.parse(observedAt);
  assert.equal(isReferenceShareable({ marketState: "ready", referenceTime: observedAt }, base + 299_999), true);
  assert.equal(isReferenceShareable({ marketState: "ready", referenceTime: observedAt }, base + 300_000), false);
  assert.equal(isReferenceShareable({ marketState: "loading", referenceTime: observedAt }, base), false);
  assert.equal(isReferenceShareable({ marketState: "ready", referenceTime: null }, base), false);
});

test("round-trips validated trade inputs in a server-private URL fragment", () => {
  const buyerFragment = buildTradeFragment({ side: "buy", amount: "3000000", premium: "2", fundingSource: "근로소득", displayUnit: "btc" });
  assert.equal(buyerFragment, "#v=2&side=buy&basis=krw&krw=3000000&premium=2&fund=salary&unit=btc");
  assert.deepEqual(parseTradeFragment(buyerFragment), { side: "buy", amount: 3_000_000, amountBasis: "krw", premium: 2, fundingSource: "근로소득", displayUnit: "btc" });

  const sellerFragment = buildTradeFragment({ side: "sell", amount: "3000000", premium: "-2.5", fundingSource: "기재하지 않음", displayUnit: "sats" });
  assert.deepEqual(parseTradeFragment(sellerFragment), { side: "sell", amount: 3_000_000, amountBasis: "bitcoin", premium: -2.5, fundingSource: "기재하지 않음", displayUnit: "sats" });
  const buyerBitcoinFragment = buildTradeFragment({ side: "buy", amount: "10000000", amountBasis: "bitcoin", premium: "2", fundingSource: "기재하지 않음", displayUnit: "btc" });
  assert.deepEqual(parseTradeFragment(buyerBitcoinFragment), { side: "buy", amount: 10_000_000, amountBasis: "bitcoin", premium: 2, fundingSource: "기재하지 않음", displayUnit: "btc" });
  const sellerKrwFragment = buildTradeFragment({ side: "sell", amount: "500000", amountBasis: "krw", premium: "2", fundingSource: "기재하지 않음", displayUnit: "sats" });
  assert.deepEqual(parseTradeFragment(sellerKrwFragment), { side: "sell", amount: 500_000, amountBasis: "krw", premium: 2, fundingSource: "기재하지 않음", displayUnit: "sats" });
  assert.equal(
    buildTradeFragment({ side: "buy", amount: Number("03000000"), premium: Number("2."), fundingSource: "기재하지 않음" }),
    "#v=2&side=buy&basis=krw&krw=3000000&premium=2&fund=none&unit=sats",
  );
  assert.deepEqual(
    parseTradeFragment("#v=1&side=buy&krw=3000000&premium=2&fund=none"),
    { side: "buy", amount: 3_000_000, amountBasis: "krw", premium: 2, fundingSource: "기재하지 않음", displayUnit: "sats" },
  );
  assert.deepEqual(
    parseTradeFragment("#v=1&side=sell&sats=3000000&premium=2&fund=none"),
    { side: "sell", amount: 3_000_000, amountBasis: "bitcoin", premium: 2, fundingSource: "기재하지 않음", displayUnit: "sats" },
  );
  for (const malformed of [
    "#v=2&side=buy&krw=3000000&premium=2&fund=none",
    "#v=2&side=buy&basis=btc&krw=3000000&premium=2&fund=none",
    "#v=2&side=sell&basis=krw&krw=500000&sats=1000&premium=2&fund=none",
    "#v=2&side=buy&basis=krw&basis=btc&krw=3000000&premium=2&fund=none",
    "#v=1&side=buy&sats=3000000&premium=2&fund=none",
    "#v=1&side=sell&sats=2100000000000001&premium=2&fund=none",
    "#v=1&side=buy&krw=3000000&premium=-100&fund=none",
    "#v=1&side=buy&krw=3000000&premium=2&fund=unknown",
    "#v=1&side=buy&krw=3000000&premium=2&premium=3&fund=none",
    "#v=1&side=buy&krw=3000000&premium=2&fund=none&unit=bits",
    "#v=1&side=buy&krw=3000000&premium=2&fund=none&unit=btc&unit=sats",
  ]) assert.equal(parseTradeFragment(malformed), null);
});

test("schedules visible market refreshes just beyond the 15-second server cache", () => {
  assert.equal(MARKET_REFRESH_INTERVAL_MS, 16_000);
  assert.equal(getMarketRefreshDelay(0, 100_000), 0);
  assert.equal(getMarketRefreshDelay(100_000, 100_000), 16_000);
  assert.equal(getMarketRefreshDelay(100_000, 115_999), 1);
  assert.equal(getMarketRefreshDelay(100_000, 116_000), 0);
  assert.equal(getMarketRefreshDelay(100_000, 120_000), 0);
});

test("keeps a strictly allowlisted trade draft in this browser for 12 hours", () => {
  const now = 1_800_000_000_000;
  const values = new Map();
  const removed = [];
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => {
      removed.push(key);
      values.delete(key);
    },
  };
  const fields = {
    tradeRole: "seller",
    krwAmounts: { buyer: "500000", seller: "800000" },
    bitcoinAmountInputs: { buyer: "0.005", seller: "0.008" },
    amountBasisByRole: { buyer: "krw", seller: "bitcoin" },
    premiumInput: "-2.5",
    fundingSources: { buyer: "근로소득", seller: "기재하지 않음" },
    bitcoinDisplayUnit: "btc",
    market: { priceKrw: 100_000_000 },
    quote: { sats: 800_000 },
    referenceTime: "2026-08-12T00:00:00.000Z",
    png: "data:image/png;base64,not-saved",
    shareStatus: "not-saved",
  };

  assert.equal(writeTradeDraft(storage, fields, now), true);
  const storedJson = values.get(TRADE_DRAFT_STORAGE_KEY);
  const storedObject = JSON.parse(storedJson);
  assert.deepEqual(Object.keys(storedObject).sort(), [
    "amountBasisByRole", "bitcoinAmountInputs", "bitcoinDisplayUnit", "fundingSources",
    "krwAmounts", "premiumInput", "savedAt", "tradeRole", "version",
  ]);
  assert.equal(storedObject.version, TRADE_DRAFT_VERSION);
  assert.equal(storedObject.savedAt, now);
  for (const forbidden of ["market", "quote", "referenceTime", "png", "shareStatus"]) {
    assert.equal(Object.hasOwn(storedObject, forbidden), false);
  }
  assert.deepEqual(readTradeDraft(storage, now + TRADE_DRAFT_TTL_MS - 1), storedObject);

  assert.equal(readTradeDraft(storage, now + TRADE_DRAFT_TTL_MS), null);
  assert.deepEqual(removed, [TRADE_DRAFT_STORAGE_KEY]);

  values.set(TRADE_DRAFT_STORAGE_KEY, JSON.stringify({ ...storedObject, savedAt: now, extra: true }));
  assert.equal(validateTradeDraft(JSON.parse(values.get(TRADE_DRAFT_STORAGE_KEY)), now), null);
  assert.equal(readTradeDraft(storage, now), null);
  assert.equal(values.has(TRADE_DRAFT_STORAGE_KEY), false);

  values.set(TRADE_DRAFT_STORAGE_KEY, "{bad json");
  assert.equal(readTradeDraft(storage, now), null);
  assert.equal(values.has(TRADE_DRAFT_STORAGE_KEY), false);

  values.set(TRADE_DRAFT_STORAGE_KEY, "x".repeat(TRADE_DRAFT_MAX_RAW_LENGTH + 1));
  assert.equal(readTradeDraft(storage, now), null);
  assert.equal(values.has(TRADE_DRAFT_STORAGE_KEY), false);

  const blockedStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(readTradeDraft(blockedStorage, now), null);
  assert.equal(writeTradeDraft(blockedStorage, fields, now), false);
});

test("hydrates a local draft once and lets an imported share link win", async () => {
  const [component, draftHelper, css] = await Promise.all([
    readFile(new URL("../app/components/P2PTradeTool.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-draft.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const hydrationBlock = component.slice(
    component.indexOf("const imported = parseTradeFragment(window.location.hash)"),
    component.indexOf("useEffect(() => {", component.indexOf("setDraftHydrated(true)")),
  );

  assert.ok(hydrationBlock.indexOf("parseTradeFragment(window.location.hash)") < hydrationBlock.indexOf("readTradeDraft(storage)"));
  assert.ok(hydrationBlock.indexOf("if (imported)") < hydrationBlock.indexOf("writeTradeDraft(storage, hydratedDraft)"));
  assert.ok(hydrationBlock.indexOf("writeTradeDraft(storage, hydratedDraft)") < hydrationBlock.indexOf("setDraftHydrated(true)"));
  assert.match(component, /if \(!draftHydrated\) return;[\s\S]*?skipNextDraftPersistence\.current[\s\S]*?writeTradeDraft\(getTradeDraftStorage\(\)/);
  assert.match(component, /shareImageAllowed = Boolean\(shareImageInput\)[\s\S]*?&& draftHydrated/);
  assert.match(component, /입력값은 이 브라우저에 최대 12시간 임시 저장되며 서버에는 저장되지 않습니다/);
  assert.doesNotMatch(component, /새 계산 시작|startNewCalculation/);
  assert.match(css, /\.trade-tool\.is-draft-hydrating[\s\S]*?visibility:\s*hidden/);
  assert.match(draftHelper, /TRADE_DRAFT_TTL_MS = 12 \* 60 \* 60 \* 1_000/);
  assert.match(draftHelper, /TRADE_DRAFT_MAX_RAW_LENGTH = 8 \* 1_024/);
});

test("renders a focused, capture-ready P2P calculator", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = (await response.text()).replace(/<!-- -->/g, "");

  assert.match(html, /<title>비트코인 P2P 계산기<\/title>/);
  assert.match(html, /<h1[^>]*>비트코인 P2P 계산기<\/h1>/);
  assert.match(html, /data-capture-card/);
  assert.match(html, /나는 비트코인을/);
  assert.match(html, /삽니다/);
  assert.match(html, /원화 보내고 BTC 받기/);
  assert.match(html, /팝니다/);
  assert.match(html, /BTC 보내고 원화 받기/);
  assert.match(html, /보낼 원화/);
  assert.match(html, /판매자 프리미엄 \(%\)/);
  assert.match(html, /판매자가 기준 시세보다 2% 높은 단가로 팝니다/);
  assert.match(html, /구매자 자금 출처/);
  assert.match(html, /<select[^>]*id="buyer-funding-source"/);
  for (const fundingSource of [
    "기재하지 않음", "근로소득", "사업소득", "연금소득", "금융소득", "임대소득",
    "자산처분대금", "퇴직금", "상속·증여", "대출·차입금", "기존 보유자금", "기타소득",
  ]) {
    assert.match(html, new RegExp(`>${fundingSource}<`));
  }
  assert.match(html, /자금 출처는 구매자가 제공하는 정보입니다. 거래 전에 서로 확인해 주세요/);
  assert.match(html, /입력값은 이 브라우저에 최대 12시간 임시 저장되며 서버에는 저장되지 않습니다/);
  assert.match(html, /현재 계산 결과 이미지 공유/);
  assert.doesNotMatch(html, /기준 시세 직접 입력|직접 입력 시세|이 가격 사용/);
  assert.doesNotMatch(html, /거래 이미지 공유/);
  assert.match(html, /업비트 최근 체결가/);
  assert.match(html, /업비트 프리미엄/);
  assert.match(html, /시장 참고값/);
  assert.match(html, /시세 조회 중/);
  assert.match(html, /시세는 합의의 기준일 뿐입니다/);
  assert.match(html, /CoinMarketCap 기준 글로벌 가격/);
  assert.match(html, /<b>온체인 수수료:<\/b><span>판매자 부담 · 구매자 수령량 차감 없음<\/span>/);
  assert.match(html, /<b>반올림:<\/b><span>1 sat·1원<\/span>/);
  assert.match(html, /<b>확인용:<\/b><span>원화 입금·BTC 수령 증빙 아님<\/span>/);
  assert.match(html, /현재 온체인 수수료율/);
  assert.match(html, /· 참고용/);
  assert.match(html, /다음 블록/);
  assert.match(html, /약 30분/);
  assert.match(html, /약 1시간/);
  assert.match(html, /sat\/vB/);
  assert.match(html, /실제 총 수수료는 보내는 지갑에서 확인/);
  assert.doesNotMatch(html, /당사자 입력|계산 미반영|자동으로 더하지|자동 반영하지/);
  assert.doesNotMatch(html, /계산 방향|원화 → sats|sats → 원화|회원가입|지갑 주소/);
});

test("keeps market data official and interaction failures recoverable", async () => {
  const [component, imageRenderer, shareTransport, tradeLink, api, css, packageJson] = await Promise.all([
    readFile(new URL("../app/components/P2PTradeTool.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-share-image.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/share-transport.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-link.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/market.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(api, /api\.upbit\.com\/v1\/ticker\?markets=KRW-BTC/);
  assert.match(api, /datalab-api\.upbit\.com\/api\/v1\/indicator\/premium\/assets\?symbols=BTC/);
  assert.match(api, /mempool\.space\/api\/v1\/fees\/recommended/);
  assert.match(api, /disparityRate/);
  assert.match(api, /fastestFee/);
  assert.match(api, /halfHourFee/);
  assert.match(api, /hourFee/);
  assert.match(api, /FEE_FRESH_CACHE_SECONDS = 60/);
  assert.match(api, /fees-backoff/);
  assert.doesNotMatch(api, /Coinbase|coinbaseKrwGap|frankfurter/i);
  assert.match(component, /fetch\(`\/api\/market\?price=\$\{includePrice \? "1" : "0"\}`, \{ cache: "no-store" \}\)/);
  assert.match(component, /시세 새로고침/);
  assert.match(component, /현재 온체인 수수료율/);
  assert.match(component, /feeRates\?\.nextBlock/);
  assert.match(component, /feeRates\?\.halfHour/);
  assert.match(component, /feeRates\?\.hour/);
  assert.match(component, /second:\s*"2-digit"/);
  assert.match(component, /function LiveMarketTime/);
  assert.match(component, /window\.setTimeout\(tick, 1_000 - \(now % 1_000\)\)/);
  assert.match(component, /\{active \? "실시간" : "연결 중"\} · \{formatTime\(currentTime \?\? tradeObservedAt\)\}/);
  assert.doesNotMatch(component, /const \[currentTime, setCurrentTime\][\s\S]{0,160}if \(!active\) return;/);
  assert.match(component, /최근 체결: \$\{formatTime\(tradeObservedAt\)\}/);
  assert.match(component, /<LiveMarketTime active=\{livePriceActive\} tradeObservedAt=\{referenceTime\} \/>/);
  assert.match(css, /\.live-market-time \{ font-variant-numeric: tabular-nums; \}/);
  assert.match(component, /약 1분마다 자동 갱신 ·/);
  assert.match(component, /className="network-fees-status"/);
  assert.match(component, /<span>mempool\.space<\/span>/);
  assert.match(component, /const marketRefreshIntervalMs = livePriceActive[\s\S]*MARKET_REFRESH_WITH_LIVE_PRICE_MS[\s\S]*MARKET_REFRESH_FALLBACK_MS/);
  assert.match(component, /const getRefreshDelay = \(\) => \{[\s\S]*lastMarketRefreshAtRef\.current[\s\S]*marketRefreshIntervalMs - elapsed/);
  assert.match(component, /document\.visibilityState !== "visible"/);
  assert.match(component, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(component, /document\.removeEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(component, /if \(activeRefresh\) \{[\s\S]*return activeRefresh\.promise/);
  assert.match(component, /marketRequestRef\.current === refresh/);
  assert.match(component, /if \(refresh\.mode === "silent" && marketRef\.current\) return/);
  assert.match(component, /pendingMarketSnapshotRef\.current = nextData/);
  assert.match(component, /applyMarketSnapshot\(pendingSnapshot, true\)/);
  assert.match(component, /preparedShareFormKeyRef\.current !== shareFormKey/);
  assert.match(component, /setShareStatus\(\(current\) => formChanged/);
  assert.doesNotMatch(component, /<dl aria-live="polite" aria-label="mempool\.space/);
  assert.doesNotMatch(component, /manualReferencePrice|기준 시세 직접 입력|직접 입력 시세|이 가격 사용/);
  assert.match(component, /navigator\.share/);
  assert.match(component, /navigator\.canShare/);
  assert.match(component, /URL\.createObjectURL/);
  assert.match(component, /effectiveKoreaPremium/);
  assert.match(component, /buyer: "기재하지 않음"/);
  assert.match(component, /seller: "기재하지 않음"/);
  assert.match(component, /fundingSourceFieldLabel = "구매자 자금 출처"/);
  assert.doesNotMatch(component, /송금 계좌 명의|제3자|확인 전/);
  assert.match(component, /buyerFundingSource: fundingSource/);
  assert.match(component, /구매자 자금 출처: \$\{fundingSource\}/);
  assert.match(component, /구매자 제공 정보 · 거래 전 상호 확인/);
  assert.match(component, /계산 시각:/);
  assert.match(component, /\[가격 계산\]/);
  const shareTextBlock = component.slice(
    component.indexOf("const shareText ="),
    component.indexOf("].join(\"\\n\")", component.indexOf("const shareText =")),
  );
  const shareTextOrder = [
    "tradeIntent,",
    "`계산 시각:",
    "`구매자 → 판매자:",
    "`판매자 → 구매자:",
    "`구매자 자금 출처:",
    '"[가격 계산]"',
    "`금액 기준:",
    "`기준:",
    "`판매자 프리미엄:",
  ].map((token) => shareTextBlock.indexOf(token));
  assert.ok(shareTextOrder.every((index) => index >= 0));
  assert.deepEqual(shareTextOrder, [...shareTextOrder].sort((left, right) => left - right));
  assert.doesNotMatch(shareTextBlock, /반올림/);
  assert.match(component, /buildTradeIntent/);
  assert.match(component, /title: tradeIntent/);
  assert.match(component, /BTC로 보기/);
  assert.match(component, /sats로 보기/);
  assert.match(component, /비트코인 표시 단위/);
  assert.match(component, /거래 금액 입력 단위/);
  assert.match(component, /<option value="krw">원/);
  assert.match(component, /<option value="sats">sats/);
  assert.match(component, /<option value="btc">BTC/);
  assert.match(component, /받을 BTC/);
  assert.match(component, /받을 사토시/);
  assert.match(component, /받을 원화/);
  assert.match(component, /보낼 BTC/);
  assert.match(component, /보낼 사토시/);
  assert.match(component, /parseBitcoinAmount\(bitcoinAmountInput, bitcoinDisplayUnit\)/);
  assert.match(component, /satsToBtcInput\(imported\.amount\)/);
  assert.match(component, /inputMode=\{amountBasis === "krw" \|\| bitcoinDisplayUnit === "sats" \? "numeric" : "decimal"\}/);
  assert.match(shareTransport, /files: \[file\]/);
  assert.match(component, /현재 시세로 다시 계산하기:/);
  assert.match(component, /parseTradeFragment\(window\.location\.hash\)/);
  assert.match(component, /window\.history\.replaceState/);
  assert.match(component, /현재 업비트 시세로 다시 계산했습니다/);
  assert.doesNotMatch(component, /새 계산 시작|startNewCalculation/);
  assert.match(tradeLink, /return `#\$\{params\.toString\(\)\}`/);
  assert.doesNotMatch(tradeLink, /price|observed|checked|koreaPremium|paymentKrw|appliedPrice/i);
  assert.match(component, /계산 결과 이미지 준비 중/);
  assert.match(component, /PNG 이미지를 저장했습니다/);
  assert.match(imageRenderer, /new File\(\[blob\]/);
  assert.match(imageRenderer, /type: "image\/png"/);
  assert.match(imageRenderer, /비트코인 기준 가격/);
  assert.match(imageRenderer, /조회 시각/);
  assert.match(imageRenderer, /referencePriceKrw/);
  assert.match(imageRenderer, /구매자 → 판매자/);
  assert.match(imageRenderer, /판매자 → 구매자/);
  assert.match(imageRenderer, /bitcoinDisplayUnit/);
  assert.match(imageRenderer, /amountBasis/);
  assert.match(imageRenderer, /금액 기준/);
  assert.match(imageRenderer, /recipientLabel/);
  assert.match(imageRenderer, /getTradeRecipientLabel/);
  assert.doesNotMatch(imageRenderer, /내가 받음/);
  assert.match(imageRenderer, /판매자 프리미엄/);
  assert.match(imageRenderer, /buyerFundingSource/);
  assert.match(imageRenderer, /구매자 자금 출처/);
  assert.match(imageRenderer, /구매자 제공 정보 · 거래 전 상호 확인/);
  assert.match(imageRenderer, /시장 참고 · 업비트 프리미엄/);
  assert.match(imageRenderer, /온체인 수수료 판매자 부담 · 구매자 수령량 차감 없음/);
  assert.doesNotMatch(imageRenderer, /반올림/);
  assert.match(imageRenderer, /확인용 · 원화 입금·BTC 수령 증빙 아님/);
  assert.match(imageRenderer, /const DARK_PANEL_HEIGHT = 652;/);
  assert.match(imageRenderer, /const INNER_PANEL_TOP = 204;/);
  assert.match(imageRenderer, /const INNER_PANEL_HEIGHT = 604;/);
  assert.match(imageRenderer, /const INNER_PANEL_VERTICAL_PADDING = 35;/);
  assert.match(imageRenderer, /roundedRect\(context, 72, 180, 1_456, DARK_PANEL_HEIGHT, 10\)/);
  assert.match(imageRenderer, /"비트코인 기준 가격", 130, INNER_PANEL_TOP \+ INNER_PANEL_VERTICAL_PADDING/);
  assert.match(imageRenderer, /INNER_PANEL_TOP \+ INNER_PANEL_HEIGHT - INNER_PANEL_VERTICAL_PADDING/);
  assert.match(imageRenderer, /"판매자 프리미엄", 145, 644/);
  assert.match(imageRenderer, /fundingSourceLine, 145, 688/);
  assert.match(imageRenderer, /premiumReference, 145, 716/);
  assert.match(imageRenderer, /calculationNote, 145, 744/);
  assert.doesNotMatch(imageRenderer, /sat\/vB|fastestFee|halfHourFee|hourFee/);
  assert.match(component, /amount: amount \?\? ""/);
  assert.match(component, /premium: premiumPercent \?\? ""/);
  assert.match(component, /tradeFragment \? `\$\{window\.location\.origin\}\/\$\{tradeFragment\}` : ""/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /aria-invalid/);
  assert.doesNotMatch(component, /setInterval|feeSats/);
  assert.match(css, /\.role-options\s*\{[^}]*grid-template-columns:\s*repeat\(2/s);
  assert.match(css, /\.trade-form\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /\.field > span:first-child, \.field > label\s*\{/);
  assert.match(css, /\.input-with-unit\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.input-with-unit b\s*\{[^}]*border-left:/s);
  assert.match(component, /className="amount-unit-chevron" aria-hidden="true">▼/);
  assert.match(component, /판매자 프리미엄 0\.1% 올리기/);
  assert.match(component, /판매자 프리미엄 0\.1% 내리기/);
  assert.match(css, /\.amount-unit-control\s*\{[^}]*width:\s*56px;[^}]*min-width:\s*56px/s);
  assert.match(css, /\.amount-unit-select\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.amount-unit-select\s*\{[^}]*font:\s*780 11px\/1\.3 var\(--sans\)/s);
  assert.match(css, /\.amount-unit-chevron\s*\{[^}]*width:\s*22px[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.amount-unit-control:focus-within::after\s*\{[^}]*inset:\s*2px[^}]*border:\s*3px solid var\(--orange-dark\)/s);
  assert.match(css, /\.premium-stepper\s*\{[^}]*width:\s*50px;[^}]*grid-template-rows:\s*repeat\(2/s);
  assert.match(css, /\.fund-source-field\s*\{[^}]*grid-column:\s*1 \/ -1/s);
  assert.match(css, /\.fund-source-field select\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.result-row dd\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(component, /className=\{`result-row transfer-row/);
  assert.match(css, /\.transfer-row dd\s*\{[^}]*font-size:/s);
  assert.match(css, /\.result-row\s*\{[^}]*min-height:\s*60px/s);
  assert.match(css, /\.result-row\.primary\s*\{[^}]*box-shadow:\s*inset 4px 0 0 var\(--orange\)/s);
  assert.match(css, /\.network-fees dl\s*\{[^}]*grid-template-columns:\s*repeat\(3/s);
  assert.match(css, /\.network-fees-status\s*\{[^}]*display:\s*flex[^}]*white-space:\s*nowrap/s);
  assert.match(css, /@media \(max-width:\s*700px\)[\s\S]*?\.network-fees > header\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.share-button\.is-background-preparing:disabled\s*\{[^}]*background:\s*var\(--orange\)/s);
  assert.match(component, /className="result-badge">내가 받음/);
  assert.match(component, /구매 조건\. 내가 보낼 원화/);
  assert.match(component, /판매 조건\. 내가 보낼 비트코인/);
  assert.match(css, /\.creator-profile nav\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.creator-profile nav\s*\{[^}]*gap:\s*8px/s);
  assert.match(css, /\.creator-profile a\s*\{[^}]*min-height:\s*48px/s);
  assert.match(css, /\.creator-profile a\s*\{[^}]*border:\s*1px solid #cbd5e1/s);
  assert.match(css, /\.creator-profile a\s*\{[^}]*border-radius:\s*7px/s);
  assert.match(css, /\.creator-profile a\s*\{[^}]*text-decoration:\s*underline/s);
  assert.match(css, /\.support-address-card button\s*\{[^}]*width:\s*44px/s);
  assert.match(css, /\.support-status:empty\s*\{[^}]*min-height:\s*0/s);
  assert.doesNotMatch(`${component}\n${imageRenderer}`, /당사자 입력|계산 미반영|자동으로 더하지|자동 반영하지/);
  const premiumNotePosition = component.indexOf('<p className="premium-note" id="premium-note">');
  const fundingFieldPosition = component.indexOf('<label className="fund-source-field"');
  const fundingNotePosition = component.indexOf('<p className="fund-source-note" id="fund-source-note">');
  assert.ok(premiumNotePosition > 0 && premiumNotePosition < fundingFieldPosition);
  assert.ok(fundingFieldPosition < fundingNotePosition);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("renders an editable public recruitment builder without changing the live calculator path", async () => {
  const [response, recruitmentComponent, recruitmentBuilder, calculator, css] = await Promise.all([
    render(),
    readFile(new URL("../app/components/TradeRecruitmentTool.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-recruitment.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/components/P2PTradeTool.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const html = (await response.text()).replace(/<!-- -->/g, "");

  assert.match(html, /<h2 id="trade-recruitment-title">거래 모집글 만들기<\/h2>/);
  assert.equal((html.match(/name="recruitment-network"/g) ?? []).length, 3);
  assert.match(html, />온체인<\/span>/);
  assert.match(html, />라이트닝<\/span>/);
  assert.match(html, />둘 다<\/span>/);
  assert.match(html, /<details class="recruitment-options">/);
  assert.match(html, /선택 문구 추가/);
  assert.match(html, /여러 개 선택 가능/);
  assert.match(html, /기존 거래자 우대 프리미엄/);
  assert.match(html, /원화 출처 설명 가능/);
  assert.match(html, /상호 신원확인 협의 가능/);
  assert.match(html, /추가 조건·메모/);
  assert.match(html, /편집 가능한 모집글 미리보기/);
  assert.match(html, /<textarea id="recruitment-preview"[^>]*>/);
  assert.doesNotMatch(html.match(/<textarea id="recruitment-preview"[^>]*>/)?.[0] ?? "", /readonly|disabled/);
  assert.match(html, /자동 문구로 되돌리기/);
  assert.match(html, /모집글 텍스트 복사/);
  assert.match(html, /실제 자금 출처 종류·주소·인보이스·QR·지급 요청을 넣지 마세요/);
  assert.match(html, /구매 \/ 300만원 \/ 2% \/ 온체인/);

  const integration = calculator.match(/<TradeRecruitmentTool[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(integration, /tradeRole=\{tradeRole\}/);
  assert.match(integration, /amountUnit=\{amountInputUnit\}/);
  assert.match(integration, /sellerPremiumInput=\{premiumInput\}/);
  assert.match(integration, /approximateKrw=\{quote\?\.paymentKrw \?\? null\}/);
  assert.match(integration, /approximateSats=\{quote\?\.sats \?\? null\}/);
  assert.match(integration, /bitcoinDisplayUnit=\{bitcoinDisplayUnit\}/);
  assert.doesNotMatch(integration, /fundingSource|market|address|invoice|qr/i);
  assert.match(recruitmentComponent, /copyTradeRecruitmentText\(previewText/);
  assert.match(recruitmentComponent, /setPreviewDirty\(value !== generated\.text\)/);
  assert.match(recruitmentComponent, /disabled=\{!previewText\.trim\(\) \|\| copying\}/);
  assert.doesNotMatch(recruitmentComponent, /previewOutdated|거래 조건이 바뀌어 다시 만들기 필요|Discord/);
  assert.match(recruitmentComponent, /tradeRole === "buyer" \? \(/);
  const recruitmentImports = recruitmentBuilder.match(/^(?:import[^\n]+\n)+/)?.[0] ?? "";
  assert.doesNotMatch(recruitmentImports, /trade-link|trade-share-image|p2p-quote|market/i);
  assert.match(recruitmentBuilder, /input\.tradeRole === "buyer" && input\.canShareKrwSource/);
  assert.match(css, /\.trade-tool\.is-draft-hydrating \.trade-recruitment \{ visibility: hidden; \}/);
  assert.match(css, /\.recruitment-option-list\s*\{[^}]*grid-template-columns:\s*repeat\(2/s);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.recruitment-memo textarea, \.recruitment-preview textarea \{ font-size: 16px; \}/);
  assert.match(calculator, /wss:\/\/api\.upbit\.com\/websocket\/v1/);
  assert.match(calculator, /requestMarketSnapshot\(includePrice\)/);
  assert.match(calculator, /calculateP2PQuote\(\{/);
});

test("renders creator identity and Lightning support details", async () => {
  await Promise.all([
    access(new URL("../public/creator-logo.jpg", import.meta.url)),
    access(new URL("../public/lightning-support-qr.png", import.meta.url)),
  ]);
  await assert.rejects(access(new URL("../public/lightning-support-qr.jpg", import.meta.url)));
  const response = await render();
  const html = (await response.text()).replace(/<!-- -->/g, "");

  assert.ok(html.includes("\uC81C\uC791\u00B7\uD3B8\uCC2C"));
  assert.ok(html.includes("\uC5C4\uC9C0\uC655"));
  assert.match(html, /src="\/creator-logo\.jpg"/);
  assert.ok(html.includes("\uC5C4\uC9C0\uC655 \uB85C\uACE0"));
  assert.match(html, /https:\/\/x\.com\/thumbking0227/);
  assert.match(html, /https:\/\/www\.threads\.com\/@thumb\.ggul/);
  assert.ok(html.includes("\uB77C\uC774\uD2B8\uB2DD\uC73C\uB85C \uD6C4\uC6D0\uD558\uAE30"));
  assert.ok(html.includes("\uC774 \uACC4\uC0B0\uAE30\uAC00 \uB3C4\uC6C0\uC774 \uB418\uC5C8\uB2E4\uBA74 \uC9C0\uC18D\uC801\uC778 \uAC80\uC99D\uACFC \uB2E4\uC74C \uBC84\uC804 \uC81C\uC791\uC744 \uD6C4\uC6D0\uD574 \uC8FC\uC138\uC694."));
  assert.match(html, /href="\/lightning-support-qr\.png"/);
  assert.ok(html.includes("\uC5C4\uC9C0\uC655 \uB77C\uC774\uD2B8\uB2DD \uD6C4\uC6D0 QR"));
  assert.ok(html.includes("\uC5C4\uC9C0\uC655 \uB77C\uC774\uD2B8\uB2DD \uD6C4\uC6D0 \uC8FC\uC18C\uB97C \uB2F4\uC740 QR \uCF54\uB4DC"));
  assert.ok(html.includes("thumbking@oksu.su"));
  assert.ok(html.includes("\uB77C\uC774\uD2B8\uB2DD \uC8FC\uC18C \uBCF5\uC0AC"));
  assert.ok(html.includes("\uD6C4\uC6D0\uD558\uAE30 \uC804, \uB77C\uC774\uD2B8\uB2DD \uC9C0\uAC11\uC5D0 \uD45C\uC2DC\uB41C \uC218\uC2E0 \uC8FC\uC18C\uAC00 \uC544\uB798 \uC8FC\uC18C\uC640 \uAC19\uC740\uC9C0 \uD655\uC778\uD574 \uC8FC\uC138\uC694."));
});

test("ships an installable PWA with the tilted v2 icon set and no cached market data", async () => {
  const [manifestText, serviceWorker, registration, installCta, siteRouteNav, css, appIconSource, maskableSource, shareRenderer, ogImage] = await Promise.all([
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PwaRegistration.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/InstallCta.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SiteRouteNav.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../public/icons/app-icon.svg", import.meta.url), "utf8"),
    readFile(new URL("../public/icons/app-icon-maskable.svg", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-share-image.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/og-v2.png", import.meta.url)),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, "비트코인 P2P 계산기");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(
    manifest.icons.map(({ src, sizes, purpose }) => ({ src, sizes, purpose })),
    [
      { src: "/icons/icon-192-v2.png", sizes: "192x192", purpose: "any" },
      { src: "/icons/icon-512-v2.png", sizes: "512x512", purpose: "any" },
      { src: "/icons/icon-maskable-512-v2.png", sizes: "512x512", purpose: "maskable" },
    ],
  );
  const iconSizes = await Promise.all([
    readPngSize(new URL("../public/icons/icon-192-v2.png", import.meta.url)),
    readPngSize(new URL("../public/icons/icon-512-v2.png", import.meta.url)),
    readPngSize(new URL("../public/icons/icon-maskable-512-v2.png", import.meta.url)),
    readPngSize(new URL("../public/icons/apple-touch-icon-v2.png", import.meta.url)),
  ]);
  assert.deepEqual(iconSizes, [
    { width: 192, height: 192 },
    { width: 512, height: 512 },
    { width: 512, height: 512 },
    { width: 180, height: 180 },
  ]);
  assert.equal(ogImage.subarray(1, 4).toString("ascii"), "PNG");
  assert.deepEqual(
    { width: ogImage.readUInt32BE(16), height: ogImage.readUInt32BE(20) },
    { width: 1200, height: 630 },
  );
  assert.ok(ogImage.byteLength < 500_000, `OG image is too large: ${ogImage.byteLength} bytes`);

  assert.match(appIconSource, /rotate\(13\.88 256 256\)/);
  assert.match(maskableSource, /rotate\(13\.88 256 256\)/);
  assert.match(shareRenderer, /bitcoin\.org\/img\/icons\/logotop\.svg/);
  assert.match(shareRenderer, /new Path2D\(BITCOIN_MARK_PATH\)/);
  assert.doesNotMatch(shareRenderer, /fillText\("[B₿]"|fillRect\(-25, -78|fillRect\(9, -78/);

  assert.match(registration, /serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
  assert.match(installCta, /beforeinstallprompt/);
  assert.match(installCta, /event\.preventDefault\(\)/);
  assert.match(installCta, /await prompt\.prompt\(\)/);
  assert.match(installCta, /await prompt\.userChoice/);
  assert.match(installCta, /appinstalled/);
  assert.match(installCta, /window-controls-overlay/);
  assert.match(installCta, /P2P 계산기를 설치할까요\?/);
  assert.match(installCta, /설치하기/);
  assert.match(installCta, /나중에/);
  assert.match(installCta, /INSTALL_INVITE_DISMISS_KEY/);
  assert.match(installCta, /showEntry = true/);
  assert.match(installCta, /"\/install\/#iphone"/);
  assert.match(installCta, /"\/install\/#android"/);
  assert.match(serviceWorker, /bitcoin-p2p-check-v4/);
  assert.match(serviceWorker, /icon-192-v2\.png/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /fetch\(request, \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(serviceWorker, /cache\.put\([^\n]*api/i);

  const response = await render();
  const html = await response.text();
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /apple-touch-icon[^>]*href="\/icons\/apple-touch-icon-v2\.png"/);
  assert.match(html, /href="\/install\/"/);
  assert.match(html, /<nav class="site-route-nav" aria-label="사이트 메뉴">/);
  assert.match(html, /aria-current="page">₿ 비트코인 P2P 계산기<\/span>/);
  assert.match(html, /class="site-route-install" href="\/install\/">홈 화면에 추가하는 방법<\/a>/);
  assert.match(siteRouteNav, /className="site-route-install" href="\/install\/"/);
  assert.match(registration, /navigatorWithStandalone\.standalone === true/);
  assert.match(registration, /"is-installed-pwa"/);
  assert.match(css, /@media \(display-mode: standalone\), \(display-mode: minimal-ui\), \(display-mode: window-controls-overlay\) \{\s*\.site-route-install \{ display: none; \}/);
  assert.match(css, /\.is-installed-pwa \.site-route-install \{ display: none; \}/);
  assert.match(html, /property="og:description" content="원화와 비트코인을 주고받을 조건을 한 화면에서 확인합니다\. 공유된 조건은 현재 시세로 다시 계산됩니다\."/);
  assert.match(html, /property="og:image" content="https:\/\/bitcoin-p2p-check\.thumbking-btc\.workers\.dev\/og-v2\.png"/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
  assert.match(html, /property="og:image:alt" content="비트코인 P2P 계산기 — 원화와 비트코인 거래 조건 계산 및 공유"/);
  assert.match(html, /name="twitter:image" content="https:\/\/bitcoin-p2p-check\.thumbking-btc\.workers\.dev\/og-v2\.png"/);
  assert.doesNotMatch(html, /https:\/\/bitcoin-p2p-check\.thumbking-btc\.workers\.dev\/og\.png/);
  assert.doesNotMatch(html, /http:\/\/localhost:3000\/og-v2\.png/);
});

test("renders BIP39-style home-screen installation guides for mobile and PC", async () => {
  const [response, iphoneSize, androidSize, installSource, css] = await Promise.all([
    render("/install"),
    readPngSize(new URL("../public/install/iphone-guide-v1.png", import.meta.url)),
    readPngSize(new URL("../public/install/android-guide-v1.png", import.meta.url)),
    readFile(new URL("../app/install/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  const html = (await response.text()).replace(/<!-- -->/g, "");

  assert.match(html, /<h1[^>]*>홈 화면에 추가하기<\/h1>/);
  assert.match(html, /자동 다운로드와는 다릅니다/);
  assert.match(html, /href="#iphone"[^>]*>iPhone<\/a>/);
  assert.match(html, /href="#android"[^>]*>Android<\/a>/);
  assert.match(html, /href="#desktop"[^>]*>PC<\/a>/);
  assert.match(html, /Discord·X 같은 앱 안에서 열었다면 Safari로 연 뒤/);
  assert.match(html, /앱 안 브라우저에서 열었다면 Chrome으로 연 뒤/);
  assert.match(html, /아래쪽의 더 보기/);
  assert.match(html, /빠른 메뉴에서 공유/);
  assert.match(html, /‘간략히 보기’라고 표시된다면/);
  assert.match(html, /펼친 목록에서 홈 화면에 추가/);
  assert.match(html, /웹 앱으로 열기/);
  assert.match(html, /설치 및 바로가기 만들기/);
  assert.match(html, /확인 창에서 설치를 누릅니다/);
  assert.match(html, /실시간 시세 확인에는 인터넷 연결이 필요합니다/);
  assert.match(html, /id="desktop"/);
  assert.match(html, /<h2>PC에서 설치<\/h2>/);
  assert.match(html, /주소창의 설치 아이콘/);
  assert.match(html, /src="\/install\/iphone-guide-v1\.png"/);
  assert.match(html, /src="\/install\/android-guide-v1\.png"/);
  const iphoneCard = html.match(/<article[^>]*id="iphone"[\s\S]*?<\/article>/)?.[0] ?? "";
  const androidCard = html.match(/<article[^>]*id="android"[\s\S]*?<\/article>/)?.[0] ?? "";
  assert.equal((iphoneCard.match(/<li>/g) ?? []).length, 5);
  assert.equal((androidCard.match(/<li>/g) ?? []).length, 3);
  assert.doesNotMatch(iphoneCard, /1단계/);
  assert.doesNotMatch(androidCard, /1단계/);
  assert.match(html, /iPhone 안내 이미지 저장/);
  assert.match(html, /Android 안내 이미지 저장/);
  assert.doesNotMatch(html, /Apple 공식 안내 보기/);
  assert.doesNotMatch(html, /Chrome 공식 안내 보기/);
  assert.match(css, /@media \(min-width: 761px\)[\s\S]*?\.install-guide-grid \{ align-items: stretch; \}[\s\S]*?\.install-guide-card \{ display: flex; flex-direction: column; \}[\s\S]*?\.install-guide-card > img \{ flex: 0 0 auto; margin-top: auto; \}/);
  assert.ok(installSource.indexOf('<ol className="install-steps">') < installSource.indexOf('src="/install/iphone-guide-v1.png"'));
  assert.ok(installSource.lastIndexOf('<ol className="install-steps">') < installSource.indexOf('src="/install/android-guide-v1.png"'));
  assert.match(html, /href="\/"[^>]*>← 계산기로 돌아가기<\/a>/);
  assert.match(html, /<footer class="site-footer site-footer-nav-only">/);
  assert.match(html, /href="\/">₿ 비트코인 P2P 계산기<\/a>/);
  assert.match(html, /aria-current="page">홈 화면에 추가하는 방법<\/span>/);
  assert.deepEqual(iphoneSize, { width: 1080, height: 1920 });
  assert.deepEqual(androidSize, { width: 1080, height: 1920 });
});

test("exports static pages and keeps only the market endpoint in the Worker", async () => {
  await Promise.all([
    access(new URL("../dist/client/index.html", import.meta.url)),
    access(new URL("../dist/client/install/index.html", import.meta.url)),
    access(new URL("../dist/client/404.html", import.meta.url)),
  ]);
  const [worker, nextConfig, wrangler, headers, css, home, packageJson] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../public/_headers", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(nextConfig, /output:\s*"export"/);
  assert.match(wrangler, /"directory":\s*"\.\/dist\/client"/);
  assert.match(wrangler, /"not_found_handling":\s*"404-page"/);
  assert.match(wrangler, /"run_worker_first":\s*\["\/api\/market",\s*"\/api\/market\/"\]/);
  assert.match(packageJson, /wrangler deploy --config wrangler\.jsonc/);
  assert.match(worker, /url\.pathname === "\/api\/market"/);
  assert.doesNotMatch(worker, /vinext\/server\/app-router-entry/);
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /Referrer-Policy:\s*no-referrer/);
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/);
  assert.match(headers, /X-Frame-Options:\s*DENY/);
  assert.match(headers, /Permissions-Policy:/);
  assert.match(css, /body\s*\{\s*min-width:\s*0/);
  assert.match(css, /\.refresh-button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(home, /<details className="reference-details">/);
  assert.doesNotMatch(home, /className="explanation"|className="source-note"/);
});
