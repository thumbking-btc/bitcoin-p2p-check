import { expect, test, type Page } from "@playwright/test";
import { createBolt11Invoice as createBolt11InvoiceFixture } from "../tests/bolt11-fixture.mjs";

const ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const AMOUNT_SATS = 1_000_000;
type Payment = { rail: string; payload: string; address?: string };
// The JS fixture accepts these options, but its default destructuring does not
// expose the required amountSats field to TypeScript consumers.
const createBolt11Invoice = createBolt11InvoiceFixture as (options: {
  amountSats: number;
  timestampSeconds?: number;
  network?: "bc" | "tb";
}) => string;

async function openReceiveInfo(page: Page) {
  let providerRequests = 0;
  const drafts: Array<{ payment: Payment | null }> = [];
  // Use the same deterministic market contract as hardening.spec.ts; its
  // private helper cannot be imported without registering that entire suite.
  await page.route("**/api/market?*", async (route) => {
    if (route.request().method() === "POST") {
      providerRequests += 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
        ok: false, code: "TEST_BLOCKED", message: "E2E provider request blocked", issuanceStatus: "not-issued",
      }) });
      return;
    }
    const checkedAt = new Date().toISOString();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      checkedAt, status: "current", priceKrw: 100_000_000, priceObservedAt: checkedAt,
      koreaPremium: 0.02, premiumCheckedAt: checkedAt, feeCheckedAt: checkedAt,
      feeRates: { nextBlock: 12, halfHour: 8, hour: 5 },
      sourceStatus: { price: "current", premium: "current", fees: "current" },
      staleAgeSeconds: { price: null, premium: null, fees: null },
    }) });
  });
  await page.routeWebSocket("wss://api.upbit.com/websocket/v1", (socket) => {
    socket.onMessage(() => socket.send(JSON.stringify({ cd: "KRW-BTC", tp: 100_000_000, ttms: Date.now() })));
  });
  await page.route("**/api/trade-record", async (route) => {
    drafts.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({
      ok: false, code: "TEST_BLOCKED", message: "E2E 기록 생성 차단",
    }) });
  });
  await page.goto("/");
  await expect(page.locator(".trade-result dl")).toBeVisible();
  await page.getByLabel("거래 금액 입력 단위").selectOption("sats");
  await page.locator("#trade-amount").focus();
  await page.locator("#trade-amount").fill(String(AMOUNT_SATS));
  await expect(page.locator("#trade-amount")).toHaveValue(String(AMOUNT_SATS));
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  return { drafts, providerRequests: () => providerRequests, share: page.locator("button.share-button") };
}

test("@production-only plain onchain and BIP21 inputs reach the card without a QR preparation click", async ({ page }) => {
  const { drafts, share } = await openReceiveInfo(page);
  const address = page.getByLabel("온체인 수취 주소");
  await address.fill(ADDRESS);
  await expect(share).toBeEnabled();
  await expect(page.getByText("결제정보 미포함", { exact: true })).toHaveCount(0);
  await share.click();
  await expect.poll(() => drafts.length).toBe(1);
  expect(drafts[0].payment).toEqual({ rail: "onchain", payload: ADDRESS, address: ADDRESS });

  const bip21 = `bitcoin:${ADDRESS}?amount=0.01`;
  await address.fill(bip21);
  await expect(share).toBeEnabled();
  await share.click();
  await expect.poll(() => drafts.length).toBe(2);
  expect(drafts[1].payment).toEqual({ rail: "onchain", payload: bip21, address: ADDRESS });
});

test("@production-only partial and mismatched payment inputs cannot silently share a card without payment", async ({ page }) => {
  const { drafts, share } = await openReceiveInfo(page);
  const address = page.getByLabel("온체인 수취 주소");
  for (const input of ["bc1q", `bitcoin:${ADDRESS}?amount=0.02`, "not-a-mainnet-address"]) {
    await address.fill(input);
    await expect(share).toBeDisabled();
    await expect(page.getByText("결제정보 미포함", { exact: true })).toHaveCount(0);
  }
  expect(drafts).toEqual([]);
  await address.fill("");
  await expect(share).toBeEnabled();
  await expect(page.getByText("결제정보 미포함", { exact: true })).toBeVisible();
});

test("@production-only automatically included payment remains stale after an amount or role change", async ({ page }) => {
  const { share } = await openReceiveInfo(page);
  await page.getByLabel("온체인 수취 주소").fill(ADDRESS);
  await expect(share).toBeEnabled();
  await page.locator("#trade-amount").focus();
  await page.locator("#trade-amount").fill("2000000");
  await expect(page.getByText("조건 변경 · 사용 중지", { exact: true })).toBeVisible();
  await expect(share).toBeDisabled();
  await page.getByRole("button", { name: "주소만 포함", exact: true }).click();
  await expect(share).toBeEnabled();
  await page.locator("#trade-role-seller").check({ force: true });
  await expect(page.getByText("조건 변경 · 사용 중지", { exact: true })).toBeVisible();
  await expect(share).toBeDisabled();
});

test("@production-only Lightning Address is included locally and requests a provider only on explicit issuance", async ({ page }) => {
  const { drafts, providerRequests, share } = await openReceiveInfo(page);
  await page.getByRole("radio", { name: "라이트닝", exact: true }).check({ force: true });
  await page.getByLabel("라이트닝 주소", { exact: true }).fill("review@example.com");
  await expect(share).toBeEnabled();
  await share.click();
  await expect.poll(() => drafts.length).toBe(1);
  expect(drafts[0].payment).toEqual({ rail: "lightning", payload: "review@example.com", address: "review@example.com" });
  expect(providerRequests()).toBe(0);
  await page.getByRole("button", { name: "결제용 인보이스 만들기", exact: true }).click();
  await expect.poll(providerRequests).toBe(1);
  await expect(share).toBeDisabled();
  await page.getByRole("button", { name: "주소만 포함", exact: true }).click();
  await expect(share).toBeEnabled();
  expect(providerRequests()).toBe(1);
});

test("@production-only a direct BOLT11 is included only when its signature amount network and expiry are valid", async ({ page }) => {
  const { drafts, providerRequests, share } = await openReceiveInfo(page);
  await page.getByRole("radio", { name: "라이트닝", exact: true }).check({ force: true });
  await page.getByRole("button", { name: "인보이스 직접 입력", exact: true }).click();
  const input = page.getByLabel("BOLT11 인보이스");
  const valid = createBolt11Invoice({ amountSats: AMOUNT_SATS });
  for (const invalid of [
    valid.slice(0, -1),
    createBolt11Invoice({ amountSats: AMOUNT_SATS + 1 }),
    createBolt11Invoice({ amountSats: AMOUNT_SATS, network: "tb" }),
    createBolt11Invoice({ amountSats: AMOUNT_SATS, timestampSeconds: Math.floor(Date.now() / 1_000) - 7_200 }),
  ]) {
    await input.fill(invalid);
    await expect(share).toBeDisabled();
  }
  await input.fill(valid);
  await expect(share).toBeEnabled();
  await share.click();
  await expect.poll(() => drafts.length).toBe(1);
  expect(drafts[0].payment).toEqual({ rail: "lightning", payload: valid });
  expect(providerRequests()).toBe(0);
});

test("@production-only late clipboard input cannot replace a newly selected payment rail", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      readText: () => new Promise<string>((resolve) => {
        Object.defineProperty(window, "__completeReceivePaste", { configurable: true, value: resolve });
      }),
    } });
  });
  const { drafts, share } = await openReceiveInfo(page);
  await page.getByRole("button", { name: "붙여넣기", exact: true }).click();
  await page.getByRole("radio", { name: "라이트닝", exact: true }).check({ force: true });
  await page.getByLabel("라이트닝 주소", { exact: true }).fill("review@example.com");
  await page.evaluate((value) => {
    const callback = (window as Window & { __completeReceivePaste?: (text: string) => void }).__completeReceivePaste;
    callback?.(value);
  }, ADDRESS);
  await expect(share).toBeEnabled();
  await share.click();
  await expect.poll(() => drafts.length).toBe(1);
  expect(drafts[0].payment).toEqual({ rail: "lightning", payload: "review@example.com", address: "review@example.com" });
});
