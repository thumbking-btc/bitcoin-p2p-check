import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import sharpFactory from "sharp";
import {
  canonicalTradeRecordBytes,
  TRADE_RECORD_SCHEMA,
  type TradeRecord,
  type TradeRecordApiSuccess,
  type TradeRecordDraft,
} from "../app/lib/trade-record";
import { decodeQrSymbols } from "../app/lib/verified-qr.mjs";

const SELLER_ID = "SSSSSSSSSSSSSSSS";
const BUYER_ID = "BBBBBBBBBBBBBBBB";
const SELLER_ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const BUYER_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const SELLER_CAPABILITY = "S".repeat(43);
const KEY_ID = "p2p-trade-record-2026-08-25";
const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const CONTINUE_LABEL = "구매자로 이어서 입력";
// Keep the test's image decoder boundary limited to PNG -> RGBA pixels.
const sharp = sharpFactory as (input: Buffer) => {
  ensureAlpha(): { raw(): { toBuffer(options: { resolveWithObject: true }): Promise<{
    data: Buffer; info: { width: number; height: number };
  }> } };
};

function sourceRecord(options: { role?: "buyer" | "seller"; basis?: "krw" | "bitcoin"; expired?: boolean } = {}): TradeRecord {
  const createdAtMs = Date.now() - (options.expired ? RETENTION_MS + 60_000 : 60_000);
  return {
    schema: TRADE_RECORD_SCHEMA,
    id: SELLER_ID,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + RETENTION_MS).toISOString(),
    condition: {
      role: options.role ?? "seller",
      amountBasis: options.basis ?? "bitcoin",
      bitcoinDisplayUnit: options.basis === "krw" ? "sats" : "btc",
      paymentKrw: 1_025_000,
      sats: 1_000_000,
      referencePriceKrw: 100_000_000,
      marketObservedAt: new Date(createdAtMs).toISOString(),
      koreaPremiumRatio: 0.02,
      sellerPremiumBps: 250,
      fundingSource: "금융소득",
    },
    payment: { rail: "onchain", payload: SELLER_ADDRESS, address: SELLER_ADDRESS },
  };
}

async function installRecordFixture(page: Page, baseURL: string, source: TradeRecord, invalidSignature = false) {
  // Substitute only the trust key at the browser boundary. Sign and verify the
  // actual canonical bytes with P-256; never turn signature verification off.
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  await page.addInitScript(({ jwk, keyId }) => {
    const nativeImport = SubtleCrypto.prototype.importKey.bind(crypto.subtle);
    Object.defineProperty(SubtleCrypto.prototype, "importKey", {
      configurable: true,
      value: (format: KeyFormat, keyData: JsonWebKey | BufferSource,
        algorithm: Parameters<typeof nativeImport>[2], extractable: boolean, keyUsages: KeyUsage[]) => {
        if (format === "jwk") {
          const suppliedKey = keyData as JsonWebKey & { kid?: string };
          return nativeImport(format, suppliedKey.kid === keyId ? jwk : suppliedKey, algorithm, extractable, keyUsages);
        }
        return nativeImport(format, keyData as BufferSource, algorithm, extractable, keyUsages);
      },
    });
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => undefined } });
  }, { jwk: publicJwk, keyId: KEY_ID });

  async function sign(record: TradeRecord): Promise<TradeRecordApiSuccess> {
    const signature = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new Uint8Array(canonicalTradeRecordBytes(record)),
    );
    return { ok: true, record, signature: Buffer.from(signature).toString("base64url"), keyId: KEY_ID,
      id: record.id, verificationUrl: `${baseURL}/verify/?id=${record.id}` };
  }
  const seller = await sign(source);
  if (invalidSignature) {
    const bytes = Buffer.from(seller.signature, "base64url");
    bytes[0] ^= 1;
    Object.assign(seller, { signature: bytes.toString("base64url") });
  }
  const sourceSnapshot = JSON.stringify(seller);
  const state: {
    drafts: TradeRecordDraft[];
    buyer: TradeRecordApiSuccess | null;
    capability: string | null;
    finalized: boolean;
    writes: Array<{ method: string; path: string; authorization?: string }>;
  } = { drafts: [], buyer: null, capability: null, finalized: false, writes: [] };

  await page.route("**/api/market?*", async (route) => {
    expect(route.request().method()).toBe("GET");
    const checkedAt = new Date().toISOString();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      checkedAt, status: "current", priceKrw: 120_000_000, priceObservedAt: checkedAt,
      koreaPremium: 0.03, premiumCheckedAt: checkedAt, feeCheckedAt: checkedAt,
      feeRates: { nextBlock: 12, halfHour: 8, hour: 5 },
      sourceStatus: { price: "current", premium: "current", fees: "current" },
      staleAgeSeconds: { price: null, premium: null, fees: null },
    }) });
  });
  await page.routeWebSocket("wss://api.upbit.com/websocket/v1", (socket) => {
    socket.onMessage(() => socket.send(JSON.stringify({ cd: "KRW-BTC", tp: 120_000_000, ttms: Date.now() })));
  });
  await page.route("**/api/trade-record**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") state.writes.push({ method, path, authorization: request.headers().authorization });
    if (method === "GET" && path === `/api/trade-record/${SELLER_ID}`) {
      // A managed response deliberately contains data the buyer must not import.
      await route.fulfill({ status: 200, json: { ...seller, lifecycle: "finalized", revokeToken: SELLER_CAPABILITY } });
    } else if (method === "POST" && path === "/api/trade-record") {
      const draft = request.postDataJSON() as TradeRecordDraft;
      state.drafts.push(draft);
      state.capability = request.headers()["idempotency-key"];
      expect(request.headers()["x-trade-record-lifecycle"]).toBe("pending");
      if (draft.payment?.rail === "lightning") throw new Error("This continuation fixture accepts only onchain payment.");
      const now = Date.now();
      state.buyer = await sign({ condition: draft.condition, payment: draft.payment, schema: TRADE_RECORD_SCHEMA, id: BUYER_ID,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + RETENTION_MS).toISOString() });
      await route.fulfill({ status: 201, json: { ...state.buyer, lifecycle: "pending", revokeToken: state.capability } });
    } else if (method === "POST" && path === `/api/trade-record/${BUYER_ID}/finalize` && state.buyer) {
      expect(request.headers().authorization).toBe(`Bearer ${state.capability}`);
      state.finalized = true;
      await route.fulfill({ status: 200, json: { ...state.buyer, lifecycle: "finalized", revokeToken: state.capability } });
    } else if (method === "GET" && path === `/api/trade-record/${BUYER_ID}` && state.finalized) {
      await route.fulfill({ status: 200, json: state.buyer });
    } else {
      await route.fulfill({ status: 404, json: { ok: false, code: "RECORD_NOT_FOUND", message: "테스트 기록 없음" } });
    }
  });
  return { state, seller, sourceSnapshot };
}

test("@production-only seller link continues as buyer and publishes an independent card at 320px", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { state, seller, sourceSnapshot } = await installRecordFixture(page, baseURL!, sourceRecord());
  await page.goto(`/verify/?id=${SELLER_ID}`);
  await expect(page.getByRole("heading", { name: "공유된 거래 조건" })).toBeVisible();
  const continuation = page.getByRole("link", { name: CONTINUE_LABEL, exact: true });
  await expect(continuation).toBeVisible();
  const href = (await continuation.getAttribute("href"))!;
  expect(href).toContain("receive=1");
  for (const privateValue of [SELLER_ADDRESS, SELLER_CAPABILITY, SELLER_ID, "금융소득", seller.signature]) {
    expect(decodeURIComponent(href)).not.toContain(privateValue);
  }
  await page.screenshot({ path: testInfo.outputPath("seller-verification-mobile.png"), fullPage: true });
  await continuation.click();
  await expect(page.locator("#trade-role-buyer")).toBeChecked();
  await expect(page.locator("#trade-amount")).toHaveValue("0.01");
  await expect(page.getByLabel("거래 금액 입력 단위")).toHaveValue("btc");
  await expect(page.getByLabel("비트코인 표시 단위")).toHaveValue("btc");
  await expect(page.locator("#seller-premium")).toHaveValue("2.5");
  await expect(page.locator("details.share-tools")).toHaveAttribute("open", "");
  await expect(page.locator("#output-mode-trade-image")).toBeChecked();
  await expect(page.getByText(/판매자의 입력값을 가져왔습니다/u)).toBeVisible();
  await expect(page.getByLabel("온체인 수취 주소")).toHaveValue("");
  await expect(page.locator("#buyer-funding-source")).toHaveValue("기재하지 않음");
  await expect(page.locator(".trade-result dl")).toContainText("1,230,000원");
  expect(state.drafts).toHaveLength(0);
  expect(new URL(page.url()).hash).not.toContain("receive=");
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(SELLER_CAPABILITY);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("buyer-prefilled-mobile.png"), fullPage: true });

  await page.getByLabel("온체인 수취 주소").fill(BUYER_ADDRESS);
  await page.getByRole("button", { name: "거래 기록 카드 준비", exact: true }).click();
  await expect(page.getByRole("button", { name: "공유 창 열기", exact: true })).toBeEnabled();
  expect(state.drafts).toHaveLength(1);
  expect(state.drafts[0]).toEqual({ condition: expect.objectContaining({ role: "buyer", amountBasis: "bitcoin",
    bitcoinDisplayUnit: "btc", sats: 1_000_000, paymentKrw: 1_230_000, sellerPremiumBps: 250,
    referencePriceKrw: 120_000_000, fundingSource: null }),
    payment: { rail: "onchain", payload: BUYER_ADDRESS, address: BUYER_ADDRESS } });
  expect(state.drafts[0].condition.marketObservedAt).not.toBe(seller.record.condition.marketObservedAt);
  expect(state.capability).not.toBe(SELLER_CAPABILITY);
  expect(state.finalized).toBe(false);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "공유 창 열기", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(testInfo.outputPath("buyer-record-card.png"));
  await expect.poll(() => state.finalized).toBe(true);
  const raster = await sharp(await readFile(testInfo.outputPath("buyer-record-card.png"))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([raster.info.width, raster.info.height]).toEqual([1_440, 1_080]);
  expect(decodeQrSymbols({ data: new Uint8ClampedArray(raster.data), width: raster.info.width, height: raster.info.height })).toEqual([BUYER_ADDRESS]);
  await page.goto(`/verify/?id=${BUYER_ID}`);
  await expect(page.getByRole("heading", { name: "공유된 거래 조건" })).toBeVisible();
  await expect(page.getByText(BUYER_ADDRESS, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: CONTINUE_LABEL, exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("buyer-verification-mobile.png"), fullPage: true });
  expect(state.writes.map(({ method, path }) => ({ method, path }))).toEqual([
    { method: "POST", path: "/api/trade-record" },
    { method: "POST", path: `/api/trade-record/${BUYER_ID}/finalize` },
  ]);
  expect(JSON.stringify(seller)).toBe(sourceSnapshot);
  await page.goto(`/verify/?id=${SELLER_ID}`);
  await expect(page.getByRole("link", { name: CONTINUE_LABEL, exact: true })).toBeVisible();
  await expect(page.getByText(SELLER_ADDRESS, { exact: true })).toBeVisible();
});

test("@production-only seller KRW basis stays fixed while the buyer sees a fresh bitcoin amount", async ({ page, baseURL }) => {
  await installRecordFixture(page, baseURL!, sourceRecord({ basis: "krw" }));
  await page.goto(`/verify/?id=${SELLER_ID}`);
  await page.getByRole("link", { name: CONTINUE_LABEL, exact: true }).click();
  await expect(page.locator("#trade-role-buyer")).toBeChecked();
  await expect(page.getByLabel("거래 금액 입력 단위")).toHaveValue("krw");
  await expect(page.locator("#trade-amount")).toHaveValue("1,025,000");
  await expect(page.locator(".trade-result dl")).toContainText("833,333 sats");
  await expect(page.getByText(/현재 시세로 다시 계산됩니다/u)).toBeVisible();
});

test("@production-only an open seller record loses continuation when its retention expires", async ({ page, baseURL }) => {
  const now = Date.now();
  await page.clock.install({ time: now - 1_000 });
  await page.clock.pauseAt(now);
  const createdAt = new Date(now - RETENTION_MS + 60_000).toISOString();
  const record = sourceRecord();
  await installRecordFixture(page, baseURL!, { ...record, createdAt,
    expiresAt: new Date(now + 60_000).toISOString(), condition: { ...record.condition, marketObservedAt: createdAt } });
  await page.goto(`/verify/?id=${SELLER_ID}`);
  await page.clock.runFor(1);
  await expect(page.getByRole("link", { name: CONTINUE_LABEL, exact: true })).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(page.getByRole("link", { name: CONTINUE_LABEL, exact: true })).toHaveCount(0);
  await expect(page.getByText("이 공유 링크의 제공 기한이 지났습니다.")).toBeVisible();
});

for (const scenario of ["invalid-signature", "buyer-record", "expired-record"] as const) {
  test(`@production-only ${scenario} cannot offer buyer continuation`, async ({ page, baseURL }) => {
    await installRecordFixture(page, baseURL!, sourceRecord({
      role: scenario === "buyer-record" ? "buyer" : "seller", expired: scenario === "expired-record",
    }), scenario === "invalid-signature");
    await page.goto(`/verify/?id=${SELLER_ID}`);
    if (scenario === "invalid-signature") {
      await expect(page.getByText("거래 기록이 서명 이후 변경되었거나 올바른 서명이 아닙니다.")).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { name: "공유된 거래 조건" })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: CONTINUE_LABEL, exact: true })).toHaveCount(0);
  });
}
