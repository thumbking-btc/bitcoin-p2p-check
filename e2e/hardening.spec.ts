import AxeBuilder from "@axe-core/playwright";
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { TRADE_RECORD_SCHEMA } from "../app/lib/trade-record";

const RECORD_ID = "AAAAAAAAAAAAAAAA";
const CREATED_AT_MS = Date.parse("2027-01-15T08:00:00.000Z");
const PAYMENT_EXPIRES_AT_MS = CREATED_AT_MS + 121_000;
const RECORD_EXPIRES_AT_MS = CREATED_AT_MS + 180 * 24 * 60 * 60 * 1_000;
const BOLT11_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function marketSnapshot(priceKrw = 100_000_000, checkedAtMs = Date.now()) {
  const checkedAt = new Date(checkedAtMs).toISOString();
  return {
    checkedAt,
    status: "current",
    priceKrw,
    priceObservedAt: checkedAt,
    koreaPremium: 0.02,
    feeRates: { nextBlock: 12, halfHour: 8, hour: 5 },
    feeCheckedAt: checkedAt,
    sourceStatus: { price: "current", premium: "current", fees: "current" },
    staleAgeSeconds: { price: null, premium: null, fees: null },
  };
}

function concatBytes(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function wordsToBytesPadded(words: number[]) {
  let accumulator = 0;
  let bits = 0;
  const output: number[] = [];
  for (const word of words) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      output.push((accumulator >> bits) & 0xff);
    }
    accumulator &= bits === 0 ? 0 : (1 << bits) - 1;
  }
  if (bits > 0) output.push((accumulator << (8 - bits)) & 0xff);
  return Uint8Array.from(output);
}

function bigIntWords(value: bigint, minimumLength = 1) {
  const words: number[] = [];
  for (let remaining = value; remaining > BigInt(0); remaining >>= BigInt(5)) {
    words.unshift(Number(remaining & BigInt(31)));
  }
  while (words.length < minimumLength) words.unshift(0);
  return words;
}

function bolt11Tag(type: string, words: number[]) {
  const typeWord = BOLT11_CHARSET.indexOf(type);
  if (typeWord < 0 || words.length > 1_023) throw new RangeError("Invalid BOLT11 test tag");
  return [typeWord, words.length >> 5, words.length & 31, ...words];
}

function signedBolt11Invoice(amountSats: number, timestampSeconds: number, expirySeconds: number) {
  const prefix = `lnbc${BigInt(amountSats) * BigInt(10)}n`;
  const signedWords = [
    ...bigIntWords(BigInt(timestampSeconds), 7),
    ...bolt11Tag("p", bech32.toWords(new Uint8Array(32).fill(0x11))),
    ...bolt11Tag("s", bech32.toWords(new Uint8Array(32).fill(0x22))),
    ...bolt11Tag("d", bech32.toWords(new TextEncoder().encode("P2P browser lifecycle test"))),
    ...bolt11Tag("x", bigIntWords(BigInt(expirySeconds))),
  ];
  const digest = sha256(concatBytes(
    new TextEncoder().encode(prefix),
    wordsToBytesPadded(signedWords),
  ));
  const recoveredSignature = secp256k1.sign(
    digest,
    new Uint8Array(32).fill(0x33),
    { prehash: false, lowS: true, format: "recovered" },
  );
  const bolt11Signature = concatBytes(recoveredSignature.slice(1), recoveredSignature.slice(0, 1));
  return bech32.encode(prefix, [...signedWords, ...bech32.toWords(bolt11Signature)], 1_200);
}

type FakeMarketOptions = Readonly<{
  checkedAtMs?: number;
  failRequestAt?: number;
  holdRequestAfter?: number;
}>;

async function installFakeMarket(
  page: Page,
  routeTarget: Page | BrowserContext = page,
  options: FakeMarketOptions = {},
) {
  await page.addInitScript(() => {
    type MessageCallback = ((event: MessageEvent<string>) => void) | null;
    type OpenCallback = ((event: Event) => void) | null;

    class DeterministicWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static instances: DeterministicWebSocket[] = [];

      readonly url: string;
      binaryType: BinaryType = "blob";
      readyState = DeterministicWebSocket.CONNECTING;
      onopen: OpenCallback = null;
      onmessage: MessageCallback = null;
      onerror: OpenCallback = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
        DeterministicWebSocket.instances.push(this);
        setTimeout(() => {
          this.readyState = DeterministicWebSocket.OPEN;
          socketState.openCount += 1;
          this.onopen?.(new Event("open"));
        }, 0);
      }

      send() {}

      close() {
        if (this.readyState === DeterministicWebSocket.CLOSED) return;
        this.readyState = DeterministicWebSocket.CLOSED;
        socketState.closeCount += 1;
        this.onclose?.(new CloseEvent("close", { code: 1_000, wasClean: true }));
      }
    }

    const socketState = { openCount: 0, closeCount: 0 };

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: DeterministicWebSocket,
    });
    Object.defineProperty(window, "__emitP2PMarketPrice", {
      configurable: true,
      value: (priceKrw: number, observedAtMs: number) => {
        const socket = DeterministicWebSocket.instances.at(-1);
        socket?.onmessage?.(new MessageEvent("message", {
          data: JSON.stringify({ cd: "KRW-BTC", tp: priceKrw, ttms: observedAtMs }),
        }));
      },
    });
    Object.defineProperty(window, "__p2pWebSocketState", {
      configurable: true,
      value: socketState,
    });
  });

  let requestCount = 0;
  let releaseFallback = () => {};
  const fallbackGate = new Promise<void>((resolve) => {
    releaseFallback = resolve;
  });
  await routeTarget.route("**/api/market?*", async (route) => {
    requestCount += 1;
    if (options.failRequestAt === requestCount) {
      await route.abort("failed");
      return;
    }
    if (options.holdRequestAfter !== undefined && requestCount >= options.holdRequestAfter) {
      await fallbackGate;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify(marketSnapshot(100_000_000, options.checkedAtMs)),
    });
  });
  return {
    requestCount: () => requestCount,
    releaseFallback,
  };
}

function signedLightningRecord() {
  const record = {
    schema: TRADE_RECORD_SCHEMA,
    id: RECORD_ID,
    createdAt: new Date(CREATED_AT_MS).toISOString(),
    expiresAt: new Date(RECORD_EXPIRES_AT_MS).toISOString(),
    condition: {
      role: "buyer",
      amountBasis: "krw",
      bitcoinDisplayUnit: "sats",
      paymentKrw: 1_000_000,
      sats: 1_000_000,
      referencePriceKrw: 100_000_000,
      marketObservedAt: new Date(CREATED_AT_MS).toISOString(),
      koreaPremiumRatio: 0.02,
      sellerPremiumBps: 0,
      fundingSource: null,
    },
    payment: {
      rail: "lightning",
      payload: "lnbc10u1ptestonlyinvoice",
      expiresAt: new Date(PAYMENT_EXPIRES_AT_MS).toISOString(),
    },
  };
  return {
    ok: true,
    record,
    signature: "A".repeat(86),
    keyId: "p2p-trade-record-2026-08-25",
    id: RECORD_ID,
    verificationUrl: `http://127.0.0.1:8787/verify/?id=${RECORD_ID}`,
  };
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

test("320px layout reflows without horizontal scrolling and receives enforced CSP", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await installFakeMarket(page);
  const response = await page.goto("/");
  const headers = response?.headers() ?? {};
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("script-src");
  expect(csp).toContain("sha256-");
  expect(csp).not.toContain("unsafe-inline");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(headers["origin-agent-cluster"]).toBe("?1");
  expect(headers["strict-transport-security"]).toContain("max-age=31536000");
  expect(headers["permissions-policy"]).toContain("camera=()");
  await expect(page.getByRole("heading", { name: "비트코인 P2P 계산기" })).toBeVisible();
  await expect(page.locator(".trade-result dl")).toBeVisible();

  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);

  for (const buttonName of ["판매자 프리미엄 0.1% 올리기", "판매자 프리미엄 0.1% 내리기"]) {
    const box = await page.getByRole("button", { name: buttonName }).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("silent WebSocket ticks keep the visual and accessible result in sync", async ({ page }) => {
  await installFakeMarket(page);
  await page.goto("/");
  const visibleResult = page.locator(".result-row.transfer-row.primary dd");
  const accessibleResult = page.locator("output.visually-hidden");
  await expect(visibleResult).toContainText("3,000,000 sats");

  await page.evaluate(() => {
    const output = document.querySelector("output.visually-hidden");
    if (!(output instanceof HTMLOutputElement)) throw new Error("Accessible result output is missing");
    const modes = [output.getAttribute("aria-live") ?? ""];
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") modes.push(record.oldValue ?? "");
      }
      modes.push(output.getAttribute("aria-live") ?? "");
    }).observe(output, {
      attributes: true,
      attributeFilter: ["aria-live"],
      attributeOldValue: true,
    });
    Object.defineProperty(window, "__p2pResultLiveModes", {
      configurable: true,
      value: modes,
    });
  });

  await page.evaluate(() => {
    const emit = (window as Window & { __emitP2PMarketPrice?: (price: number, observedAt: number) => void }).__emitP2PMarketPrice;
    emit?.(110_000_000, Date.now());
  });

  await expect(visibleResult).toContainText("2,727,273 sats");
  await expect(accessibleResult).toContainText("2,727,273 sats");
  await expect(accessibleResult).toHaveAttribute("aria-live", "polite");
  const observedModes = await page.evaluate(() => (
    window as Window & { __p2pResultLiveModes?: string[] }
  ).__p2pResultLiveModes ?? []);
  expect(observedModes).toContain("off");
});

test("the calculator blocks sharing at the 121 to 120 to 119 to 0 invoice boundary", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS });
  await page.clock.pauseAt(CREATED_AT_MS);
  await installFakeMarket(page, page, { checkedAtMs: CREATED_AT_MS });
  const invoice = signedBolt11Invoice(3_000_000, Math.floor(CREATED_AT_MS / 1_000), 121);
  const capturedRequest: {
    draft: { payment?: { rail?: string; payload?: string } | null } | null;
    headers: Record<string, string>;
  } = { draft: null, headers: {} };
  await page.route("**/api/trade-record", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    capturedRequest.draft = route.request().postDataJSON() as typeof capturedRequest.draft;
    capturedRequest.headers = route.request().headers();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, code: "TEST_BLOCKED", message: "E2E 기록 생성 차단" }),
    });
  });

  await page.goto("/");
  await page.clock.runFor(1);
  await expect(page.getByRole("heading", { name: "비트코인 P2P 계산기" })).toBeVisible();
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await page.getByRole("radio", { name: "라이트닝" }).check({ force: true });
  await page.getByRole("button", { name: "인보이스 직접 입력" }).click();
  await page.getByLabel("BOLT11 인보이스").fill(invoice);
  await page.getByRole("button", { name: "인보이스 확인" }).click();

  const shareButton = page.locator("button.share-button");
  await expect(page.getByText(/2:01 남음/u)).toBeVisible();
  await expect(page.getByText("카드에 포함됨", { exact: true })).toBeVisible();
  await expect(shareButton).toBeEnabled();

  await shareButton.click();
  await expect.poll(() => capturedRequest.draft?.payment?.payload ?? null).toBe(invoice);
  expect(capturedRequest.draft?.payment).toEqual({ rail: "lightning", payload: invoice });
  expect(capturedRequest.headers["x-trade-record-lifecycle"]).toBe("pending");
  expect(capturedRequest.headers["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{43}$/u);

  await page.clock.fastForward(1_000);
  await expect(page.getByText(/2:00 남음/u)).toBeVisible();
  await expect(shareButton).toBeEnabled();

  await page.clock.fastForward(1_000);
  await expect(page.getByText(/1:59 남음/u)).toBeVisible();
  await expect(page.getByText("곧 만료 · 포함 중지", { exact: true })).toBeVisible();
  await expect(page.getByText("결제정보를 다시 확인해야 합니다.", { exact: true })).toBeVisible();
  await expect(shareButton).toBeDisabled();

  await page.clock.fastForward(119_000);
  await expect(page.getByText(/· 만료됨/u)).toBeVisible();
  await expect(page.getByText("만료 · 포함 중지", { exact: true })).toBeVisible();
  await expect(shareButton).toBeDisabled();
});

test("a silent WebSocket watchdog failure blocks sharing until REST recovery", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS });
  await page.clock.pauseAt(CREATED_AT_MS);
  const market = await installFakeMarket(page, page, {
    checkedAtMs: CREATED_AT_MS,
    holdRequestAfter: 2,
  });
  await page.goto("/");
  await page.clock.runFor(1);
  await expect.poll(async () => page.evaluate(() => (
    window as Window & { __p2pWebSocketState?: { openCount: number } }
  ).__p2pWebSocketState?.openCount ?? 0)).toBe(1);

  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  const shareButton = page.locator("button.share-button");
  await expect(shareButton).toBeEnabled();

  await page.clock.runFor(20_000);
  await expect.poll(async () => page.evaluate(() => (
    window as Window & { __p2pWebSocketState?: { closeCount: number } }
  ).__p2pWebSocketState?.closeCount ?? 0)).toBeGreaterThanOrEqual(1);
  await expect.poll(market.requestCount).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("실시간 시세 수신이 중단되었습니다. 최신 시세를 다시 확인하고 있습니다.", { exact: true })).toBeVisible();
  await expect(shareButton).toBeDisabled();

  market.releaseFallback();
  await expect(page.getByText("실시간 시세 수신이 중단되었습니다. 최신 시세를 다시 확인하고 있습니다.", { exact: true })).toHaveCount(0);
  await expect(shareButton).toBeEnabled();
});

test("a fresh WebSocket tick clears a failed silent-refresh sharing error", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS });
  await page.clock.pauseAt(CREATED_AT_MS);
  await installFakeMarket(page, page, { checkedAtMs: CREATED_AT_MS, failRequestAt: 2 });
  await page.goto("/");
  await page.clock.runFor(1);

  const emitCurrentPrice = async (priceKrw: number) => page.evaluate((price) => {
    const scope = window as Window & { __emitP2PMarketPrice?: (value: number, observedAtMs: number) => void };
    scope.__emitP2PMarketPrice?.(price, Date.now());
  }, priceKrw);
  await emitCurrentPrice(100_000_000);
  for (const price of [101_000_000, 102_000_000, 103_000_000]) {
    await page.clock.runFor(19_000);
    await emitCurrentPrice(price);
  }
  await page.clock.runFor(3_100);

  const automaticFailure = page.getByText(
    "자동 시세 갱신에 실패했습니다. 마지막 조회값은 확인용으로만 표시하며 공유할 수 없습니다.",
    { exact: true },
  );
  await expect(automaticFailure).toBeVisible();

  await emitCurrentPrice(104_000_000);
  await expect(automaticFailure).toHaveCount(0);
  await expect(page.getByText("104,000,000원", { exact: false }).first()).toBeVisible();
});

test("an open verification page disables an invoice exactly when it expires", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS });
  await page.clock.pauseAt(CREATED_AT_MS);
  await page.addInitScript(() => {
    Object.defineProperty(SubtleCrypto.prototype, "verify", {
      configurable: true,
      value: async () => true,
    });
  });
  await page.route(`**/api/trade-record/${RECORD_ID}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(signedLightningRecord()) });
  });

  await page.goto(`/verify/?id=${RECORD_ID}`);
  await page.clock.runFor(1);
  await expect(page.getByRole("heading", { name: "공유된 거래 조건" })).toBeVisible();
  await expect(page.getByRole("button", { name: "인보이스 복사" })).toBeVisible();
  await expect(page.getByText("이 인보이스는 만료되었습니다.")).toHaveCount(0);
  await page.clock.fastForward(2_000);
  await expect(page.getByText("119초 남음")).toBeVisible();
  await expect(page.getByRole("button", { name: "인보이스 복사" })).toBeVisible();

  await page.clock.fastForward(119_000);
  await expect(page.getByText("이 인보이스는 만료되었습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "인보이스 복사" })).toHaveCount(0);
  await expect(page.getByText("결제 QR 보기")).toHaveCount(0);
});

test("@pwa the service worker preserves the verification shell and uses a real 404 offline", async ({ page, context }) => {
  await installFakeMarket(page, context);
  const serviceWorkerResponse = await context.request.get("/sw.js");
  expect(serviceWorkerResponse.status()).toBe(200);
  expect(serviceWorkerResponse.headers()["cache-control"]).toContain("no-store");
  expect(serviceWorkerResponse.headers()["service-worker-allowed"]).toBe("/");
  await page.goto("/");
  await expect.poll(async () => {
    try {
      return await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        return Boolean(navigator.serviceWorker.controller);
      });
    } catch {
      return false;
    }
  }, { timeout: 30_000 }).toBe(true);
  await page.waitForLoadState("domcontentloaded");
  const requiredPrecacheEntries = await page.evaluate(async () => {
    const cacheName = (await caches.keys()).find((name) => name.startsWith("bitcoin-p2p-check-precache-"));
    if (!cacheName) return [];
    const cache = await caches.open(cacheName);
    const matches = await Promise.all(["/verify/", "/404"].map(async (path) => (
      (await cache.match(path)) ? path : null
    )));
    return matches.filter((path): path is string => path !== null);
  });
  expect(requiredPrecacheEntries).toEqual(["/verify/", "/404"]);

  await context.setOffline(true);
  await page.goto(`/verify/?id=${RECORD_ID}`);
  await expect(page.getByRole("heading", { name: "공유된 거래 정보" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "비트코인 P2P 계산기" })).toHaveCount(0);
  await expect(page.getByText("오프라인 상태에서는 거래 기록 상세를 불러올 수 없습니다.")).toBeVisible();

  const notFoundResponse = await page.goto("/offline-route-that-does-not-exist");
  expect(notFoundResponse?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "페이지를 찾을 수 없습니다" })).toBeVisible();
});

test("primary routes have no automated WCAG A/AA violations", async ({ page }) => {
  await installFakeMarket(page);
  const routes = [
    { path: "/", heading: "비트코인 P2P 계산기" },
    { path: "/install/", heading: "홈 화면에 추가하기" },
    { path: "/privacy/", heading: "개인정보·데이터 안내" },
    { path: "/verify/?id=invalid", heading: "공유된 거래 정보", error: "확인할 수 없습니다." },
    { path: "/404.html", heading: "페이지를 찾을 수 없습니다" },
  ];
  for (const { path, heading, error } of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    if (error) await expect(page.getByRole("alert").getByText(error, { exact: true })).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
  }
});
