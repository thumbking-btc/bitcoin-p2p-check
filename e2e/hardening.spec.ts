import AxeBuilder from "@axe-core/playwright";
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { TRADE_RECORD_SCHEMA } from "../app/lib/trade-record";
import {
  LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY,
  MANAGED_TRADE_RECORD_CLOCK_SKEW_GRACE_MS,
  MANAGED_TRADE_RECORD_STORAGE_PREFIX,
} from "../app/lib/trade-share-session";

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

function signedLightningRecord(id = RECORD_ID, revokeToken?: string) {
  const record = {
    schema: TRADE_RECORD_SCHEMA,
    id,
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
    id,
    verificationUrl: `http://127.0.0.1:8787/verify/?id=${id}`,
    ...(revokeToken ? { lifecycle: "finalized", revokeToken } : {}),
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
  await page.route("**/api/version", async (route) => route.abort());
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
  const deploymentNotice = page.locator("#deployment-environment-notice");
  await expect(deploymentNotice).toBeVisible();
  await expect(deploymentNotice).toContainText("PREVIEW");
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

test("record-scoped revoke capabilities survive reload and merge independent storage events", async ({ page }) => {
  await installFakeMarket(page);
  await page.goto("/");
  const firstId = "AAAAAAAAAAAAAAAB";
  const secondId = "AAAAAAAAAAAAAAAC";
  const storeRecord = async (id: string, revokeToken: string, dispatchEvent: boolean) => page.evaluate((value) => {
    const serialized = JSON.stringify({
      id: value.id,
      revokeToken: value.revokeToken,
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalized",
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    const key = `${value.prefix}${value.id}`;
    window.localStorage.setItem(key, serialized);
    if (value.dispatchEvent) {
      window.dispatchEvent(new StorageEvent("storage", {
        key,
        newValue: serialized,
        storageArea: window.localStorage,
        url: window.location.href,
      }));
    }
  }, { id, revokeToken, dispatchEvent, prefix: MANAGED_TRADE_RECORD_STORAGE_PREFIX });

  await storeRecord(firstId, "a".repeat(43), false);
  await page.reload();
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect(page.getByText("거래 기록 관리", { exact: true })).toBeVisible();
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/저장하지 못한 공개 기록/u)).toHaveCount(0);

  const tokenAfterLegacyCollision = await page.evaluate((value) => {
    const scopedKey = `${value.prefix}${value.id}`;
    const current = JSON.parse(window.localStorage.getItem(scopedKey) ?? "null") as Record<string, unknown>;
    const stale = { ...current, revokeToken: "z".repeat(43) };
    const serialized = JSON.stringify([stale]);
    window.localStorage.setItem(value.legacyKey, serialized);
    window.dispatchEvent(new StorageEvent("storage", {
      key: value.legacyKey,
      newValue: serialized,
      storageArea: window.localStorage,
      url: window.location.href,
    }));
    return JSON.parse(window.localStorage.getItem(scopedKey) ?? "null").revokeToken as string;
  }, {
    id: firstId,
    legacyKey: LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY,
    prefix: MANAGED_TRADE_RECORD_STORAGE_PREFIX,
  });
  expect(tokenAfterLegacyCollision).toBe("a".repeat(43));

  await page.evaluate(({ id, prefix }) => {
    const key = `${prefix}${id}`;
    window.localStorage.setItem(key, "not-json");
    window.dispatchEvent(new StorageEvent("storage", {
      key,
      newValue: "not-json",
      storageArea: window.localStorage,
      url: window.location.href,
    }));
  }, { id: firstId, prefix: MANAGED_TRADE_RECORD_STORAGE_PREFIX });
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/저장하지 못한 공개 기록/u)).toBeVisible();
  await storeRecord(firstId, "a".repeat(43), true);
  await expect(page.getByText(/저장하지 못한 공개 기록/u)).toHaveCount(0);

  const finalizedExpiresAt = await page.evaluate(({ id, prefix }) => {
    const key = `${prefix}${id}`;
    const finalized = JSON.parse(window.localStorage.getItem(key) ?? "null") as Record<string, unknown>;
    const stale = JSON.stringify({
      ...finalized,
      lifecycle: "pending",
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
    });
    window.localStorage.setItem(key, stale);
    window.dispatchEvent(new StorageEvent("storage", {
      key,
      newValue: stale,
      storageArea: window.localStorage,
      url: window.location.href,
    }));
    return finalized.expiresAt as string;
  }, { id: firstId, prefix: MANAGED_TRADE_RECORD_STORAGE_PREFIX });
  await expect.poll(() => page.evaluate(({ id, prefix }) => {
    const restored = JSON.parse(window.localStorage.getItem(`${prefix}${id}`) ?? "null") as Record<string, unknown>;
    return { expiresAt: restored?.expiresAt, lifecycle: restored?.lifecycle };
  }, { id: firstId, prefix: MANAGED_TRADE_RECORD_STORAGE_PREFIX })).toEqual({
    expiresAt: finalizedExpiresAt,
    lifecycle: "finalized",
  });
  await page.reload();
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(1);

  await page.evaluate(() => {
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", {
      key: null,
      newValue: null,
      storageArea: window.localStorage,
      url: window.location.href,
    }));
  });
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/저장하지 못한 공개 기록/u)).toBeVisible();
  await storeRecord(firstId, "a".repeat(43), true);
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(1);
  await expect.poll(() => page.evaluate(
    ({ id, prefix }) => window.localStorage.getItem(`${prefix}${id}`),
    { id: firstId, prefix: MANAGED_TRADE_RECORD_STORAGE_PREFIX },
  )).toBeNull();

  await storeRecord(secondId, "b".repeat(43), true);
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(2);
  await page.evaluate(({ id, prefix }) => {
    const key = `${prefix}${id}`;
    window.localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", {
      key,
      newValue: null,
      storageArea: window.localStorage,
      url: window.location.href,
    }));
  }, { id: secondId, prefix: MANAGED_TRADE_RECORD_STORAGE_PREFIX });
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(1);
});

test("a forward browser-clock jump across apparent expiry does not delete a capability", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS });
  await installFakeMarket(page, page, { checkedAtMs: CREATED_AT_MS });
  const id = "AAAAAAAAAAAAAAAK";
  const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${id}`;
  await page.addInitScript((value) => {
    window.localStorage.setItem(value.key, JSON.stringify({
      id: value.id,
      revokeToken: "k".repeat(43),
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalized",
      expiresAt: new Date(value.expiresAtMs).toISOString(),
    }));
  }, { expiresAtMs: CREATED_AT_MS + 60_000, id, key });

  await page.goto("/");
  await page.clock.runFor(1);
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect(page.getByText("공개 기록", { exact: true })).toBeVisible();

  await page.clock.fastForward(61_000);
  await expect(page.getByText("공개 기록", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)).not.toBeNull();
});

test("a conflicting record-scoped token cannot replace the capability already held by an open tab", async ({ page }) => {
  await installFakeMarket(page);
  const id = "AAAAAAAAAAAAAAAI";
  const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${id}`;
  const originalToken = "i".repeat(43);
  await page.addInitScript((value) => {
    window.localStorage.setItem(value.key, JSON.stringify({
      id: value.id,
      revokeToken: value.token,
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalized",
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
    }));
  }, { id, key, token: originalToken });
  let authorization = "";
  await page.route(`**/api/trade-record/${id}`, async (route) => {
    authorization = route.request().headers().authorization ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, id }),
    });
  });

  await page.goto("/");
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(1);
  await page.evaluate((value) => {
    const conflicting = JSON.stringify({
      id: value.id,
      revokeToken: "z".repeat(43),
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalized",
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    window.localStorage.setItem(value.key, conflicting);
    window.dispatchEvent(new StorageEvent("storage", {
      key: value.key,
      newValue: conflicting,
      storageArea: window.localStorage,
      url: window.location.href,
    }));
  }, { id, key });

  await expect(page.getByText(/서로 다른 철회 권한이 감지/u)).toBeVisible();
  await expect.poll(() => page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)).toBeNull();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `공개 기록 ${id} 철회` }).click();
  await expect.poll(() => authorization).toBe(`Bearer ${originalToken}`);
});

test("permanent revoke failures discard unusable browser capabilities", async ({ page }) => {
  await installFakeMarket(page);
  const invalidId = "AAAAAAAAAAAAAAAM";
  const missingId = "AAAAAAAAAAAAAAAN";
  const records = [
    { id: invalidId, revokeToken: "m".repeat(43) },
    { id: missingId, revokeToken: "n".repeat(43) },
  ];
  await page.addInitScript(({ prefix, values }) => {
    for (const value of values) {
      window.localStorage.setItem(`${prefix}${value.id}`, JSON.stringify({
        id: value.id,
        revokeToken: value.revokeToken,
        verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
        lifecycle: "finalized",
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
      }));
    }
  }, { prefix: MANAGED_TRADE_RECORD_STORAGE_PREFIX, values: records });
  await page.route("**/api/trade-record/*", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const invalid = id === invalidId;
    await route.fulfill({
      status: invalid ? 403 : 404,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({
        ok: false,
        code: invalid ? "INVALID_CAPABILITY" : "RECORD_NOT_FOUND",
        message: invalid ? "권한 없음" : "기록 없음",
      }),
    });
  });

  await page.goto("/");
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(2);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `공개 기록 ${invalidId} 철회` }).click();
  await expect(page.getByText(/관리 권한이 더 이상 유효하지 않아/u)).toBeVisible();
  await expect.poll(() => page.evaluate(
    (key) => window.localStorage.getItem(key),
    `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${invalidId}`,
  )).toBeNull();
  await expect(page.getByRole("button", { name: `공개 기록 ${invalidId} 철회` })).toHaveCount(0);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `공개 기록 ${missingId} 철회` }).click();
  await expect(page.getByText(/이미 없거나 철회되어/u)).toBeVisible();
  await expect.poll(() => page.evaluate(
    (key) => window.localStorage.getItem(key),
    `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${missingId}`,
  )).toBeNull();
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(0);
});

test("a non-contract edge 403 preserves the only revoke capability", async ({ page }) => {
  await installFakeMarket(page);
  const id = "AAAAAAAAAAAAAAAP";
  const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${id}`;
  await page.addInitScript((value) => {
    window.localStorage.setItem(value.key, JSON.stringify({
      id: value.id,
      revokeToken: "p".repeat(43),
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalized",
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
    }));
  }, { id, key });
  await page.route(`**/api/trade-record/${id}`, async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "text/html",
      headers: { "Cache-Control": "no-store" },
      body: "<html><body>temporary edge denial</body></html>",
    });
  });

  await page.goto("/");
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `공개 기록 ${id} 철회` }).click();

  await expect(page.getByText(/거래 기록을 철회하지 못했습니다/u)).toBeVisible();
  await expect.poll(() => page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)).not.toBeNull();
  await expect(page.getByRole("button", { name: `공개 기록 ${id} 철회` })).toBeVisible();
});

test("a rapid cross-tab clear prevents a stale capability write from restoring browser persistence", async ({ context, page }) => {
  await installFakeMarket(page);
  await page.goto("/");
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });

  const sourcePage = await context.newPage();
  await sourcePage.goto("/privacy/");
  const id = "AAAAAAAAAAAAAAAF";
  const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${id}`;
  await sourcePage.evaluate((value) => {
    const serialized = JSON.stringify({
      id: value.id,
      revokeToken: "f".repeat(43),
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalized",
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    window.localStorage.setItem(value.key, serialized);
    window.localStorage.clear();
    window.localStorage.setItem(value.key, serialized);
  }, { id, key });

  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/저장하지 못한 공개 기록/u)).toBeVisible();
  await expect.poll(async () => Promise.all([
    page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key),
    sourcePage.evaluate((storageKey) => window.localStorage.getItem(storageKey), key),
  ])).toEqual([null, null]);

  await sourcePage.evaluate((value) => {
    window.localStorage.setItem(value.legacyKey, JSON.stringify([{
      id: value.id,
      revokeToken: "f".repeat(43),
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalized",
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
    }]));
  }, { id, legacyKey: LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY });
  await expect.poll(async () => Promise.all([
    page.evaluate((storageKey) => window.localStorage.getItem(storageKey), LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY),
    sourcePage.evaluate((storageKey) => window.localStorage.getItem(storageKey), LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY),
  ])).toEqual([null, null]);

  await page.reload();
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  const tradeRecordCardModeAfterReload = page.getByRole("radio", { name: /거래 기록 카드/u });
  await expect(tradeRecordCardModeAfterReload).toBeEnabled();
  await tradeRecordCardModeAfterReload.check({ force: true });
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(0);
  await sourcePage.close();
});

test("a failed revoke after storage is cleared keeps the capability memory-only", async ({ page }) => {
  await installFakeMarket(page);
  const id = "AAAAAAAAAAAAAAAJ";
  const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${id}`;
  const revokeToken = "j".repeat(43);
  await page.addInitScript((value) => {
    window.localStorage.setItem(value.key, JSON.stringify({
      id: value.id,
      revokeToken: value.revokeToken,
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalized",
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
    }));
  }, { id, key, revokeToken });
  let authorization = "";
  await page.route(`**/api/trade-record/${id}`, async (route) => {
    authorization = route.request().headers().authorization ?? "";
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, code: "TEMPORARILY_UNAVAILABLE", message: "잠시 후 다시 시도" }),
    });
  });

  await page.goto("/");
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect(page.getByText("공개 기록", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", {
      key: null,
      newValue: null,
      storageArea: window.localStorage,
      url: window.location.href,
    }));
  });
  await expect(page.getByText(/저장하지 못한 공개 기록/u)).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `공개 기록 ${id} 철회` }).click();
  await expect(page.getByText(/거래 기록을 철회하지 못했습니다/u)).toBeVisible();
  await expect(page.getByText(/저장하지 못한 공개 기록/u)).toBeVisible();
  await expect.poll(() => page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)).toBeNull();
  expect(authorization).toBe(`Bearer ${revokeToken}`);
});

test("a persisted unresolved finalization retries idempotently and removes a missing private record", async ({ page }) => {
  await installFakeMarket(page);
  const id = "AAAAAAAAAAAAAAAD";
  const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${id}`;
  await page.addInitScript((value) => {
    window.localStorage.setItem(value.key, JSON.stringify({
      id: value.id,
      revokeToken: "d".repeat(43),
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalizing",
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000).toISOString(),
    }));
  }, { id, key });
  let recordReads = 0;
  await page.route(`**/api/trade-record/${id}/finalize`, async (route) => {
    recordReads += 1;
    expect(route.request().method()).toBe("POST");
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, code: "RECORD_NOT_FOUND", message: "기록 없음" }),
    });
  });

  await page.goto("/");
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect.poll(() => recordReads).toBeGreaterThanOrEqual(1);
  await expect.poll(
    () => page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key),
    { timeout: 15_000 },
  ).toBeNull();
  await expect(page.getByText("확정 상태 확인 필요", { exact: true })).toHaveCount(0);
  expect(recordReads).toBeGreaterThanOrEqual(1);
});

test("a permanent finalization authorization failure removes the invalid capability without retrying", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS });
  await installFakeMarket(page, page, { checkedAtMs: CREATED_AT_MS });
  const id = "AAAAAAAAAAAAAAAM";
  const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${id}`;
  await page.addInitScript((value) => {
    window.localStorage.setItem(value.key, JSON.stringify({
      id: value.id,
      revokeToken: "m".repeat(43),
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalizing",
      expiresAt: new Date(value.expiresAtMs).toISOString(),
    }));
  }, { expiresAtMs: RECORD_EXPIRES_AT_MS, id, key });
  let finalizeRequests = 0;
  await page.route(`**/api/trade-record/${id}/finalize`, async (route) => {
    finalizeRequests += 1;
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, code: "INVALID_CAPABILITY", message: "권한 없음" }),
    });
  });

  await page.goto("/");
  await page.clock.runFor(1);
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect.poll(() => finalizeRequests).toBe(1);
  await expect(page.getByText(/유효하지 않은 거래 기록 관리 권한을 브라우저 저장소에서 제거했습니다/u)).toBeVisible();
  await expect.poll(() => page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)).toBeNull();
  await expect(page.getByText("확정 상태 확인 필요", { exact: true })).toHaveCount(0);

  await page.clock.fastForward(5 * 60_000 + 1_000);
  expect(finalizeRequests).toBe(1);
});

test("a non-contract finalization 403 keeps the capability for retry", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS });
  await installFakeMarket(page, page, { checkedAtMs: CREATED_AT_MS });
  const id = "AAAAAAAAAAAAAAAQ";
  const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${id}`;
  await page.addInitScript((value) => {
    window.localStorage.setItem(value.key, JSON.stringify({
      id: value.id,
      revokeToken: "q".repeat(43),
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalizing",
      expiresAt: new Date(value.expiresAtMs).toISOString(),
    }));
  }, { expiresAtMs: RECORD_EXPIRES_AT_MS, id, key });
  let finalizeRequests = 0;
  await page.route(`**/api/trade-record/${id}/finalize`, async (route) => {
    finalizeRequests += 1;
    await route.fulfill({
      status: 403,
      contentType: "text/html",
      headers: { "Cache-Control": "no-store" },
      body: "<html><body>temporary edge denial</body></html>",
    });
  });

  await page.goto("/");
  await page.clock.runFor(1);
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect.poll(() => finalizeRequests).toBe(1);
  await expect.poll(() => page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key)).not.toBeNull();
  await expect(page.getByText("확정 상태 확인 필요", { exact: true })).toBeVisible();

  await page.clock.fastForward(5 * 60_000 + 1_000);
  await expect.poll(() => finalizeRequests).toBeGreaterThan(1);
});

test("a memory-only finalizing 404 stops at the pending recovery deadline", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS });
  await installFakeMarket(page, page, { checkedAtMs: CREATED_AT_MS });
  const id = "AAAAAAAAAAAAAAAL";
  const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${id}`;
  const recoveryDeadlineMs = CREATED_AT_MS + 60_000;
  const finalExpiresAtMs = recoveryDeadlineMs
    + 180 * 24 * 60 * 60 * 1_000
    - 15 * 60 * 1_000
    - MANAGED_TRADE_RECORD_CLOCK_SKEW_GRACE_MS;
  await page.addInitScript((value) => {
    window.localStorage.setItem(value.key, JSON.stringify({
      id: value.id,
      revokeToken: "l".repeat(43),
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalizing",
      expiresAt: new Date(value.finalExpiresAtMs).toISOString(),
    }));
  }, { finalExpiresAtMs, id, key });
  let finalizeRequests = 0;
  let publicReads = 0;
  let releaseFinalize = () => {};
  const finalizeGate = new Promise<void>((resolve) => {
    releaseFinalize = resolve;
  });
  await page.route(new RegExp(`/api/trade-record/${id}(?:/finalize)?$`, "u"), async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/finalize")) {
      finalizeRequests += 1;
      await finalizeGate;
      try {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, code: "TEST_DELAYED", message: "지연됨" }),
        });
      } catch {
        // The clear event aborts this authenticated retry before switching to a public read.
      }
      return;
    }
    publicReads += 1;
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, code: "RECORD_NOT_FOUND", message: "기록 없음" }),
    });
  });

  await page.goto("/");
  await page.clock.runFor(1);
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  const tradeRecordCardMode = page.getByRole("radio", { name: /거래 기록 카드/u });
  await expect(tradeRecordCardMode).toBeEnabled();
  await tradeRecordCardMode.check({ force: true });
  await expect.poll(() => finalizeRequests).toBe(1);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", {
      key: null,
      newValue: null,
      storageArea: window.localStorage,
      url: window.location.href,
    }));
  });
  await expect.poll(() => publicReads).toBeGreaterThanOrEqual(1);
  await expect(page.getByText("확정 상태 확인 필요", { exact: true })).toBeVisible();
  await expect(page.locator(".managed-trade-records time")).toHaveAttribute(
    "datetime",
    new Date(recoveryDeadlineMs).toISOString(),
  );

  await page.clock.fastForward(61_000);
  await expect(page.getByText("확정 상태 확인 필요", { exact: true })).toHaveCount(0);
  expect(finalizeRequests).toBe(1);
  releaseFinalize();
});

test("clearing browser storage during reconciliation keeps a confirmed capability in memory only", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS });
  await installFakeMarket(page, page, { checkedAtMs: CREATED_AT_MS });
  const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${RECORD_ID}`;
  await page.addInitScript((value) => {
    window.localStorage.setItem(value.key, JSON.stringify({
      id: value.id,
      revokeToken: "e".repeat(43),
      verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
      lifecycle: "finalizing",
      expiresAt: new Date(value.expiresAtMs).toISOString(),
    }));
  }, { expiresAtMs: RECORD_EXPIRES_AT_MS, id: RECORD_ID, key });
  let releaseRecordRead = () => {};
  const recordReadGate = new Promise<void>((resolve) => {
    releaseRecordRead = resolve;
  });
  let finalizeRequests = 0;
  let readRequests = 0;
  await page.route(new RegExp(`/api/trade-record/${RECORD_ID}(?:/finalize)?$`, "u"), async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/finalize")) {
      finalizeRequests += 1;
      await recordReadGate;
    } else {
      readRequests += 1;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify(signedLightningRecord(RECORD_ID, "e".repeat(43))),
      });
    } catch {
      // Clearing storage switches the persisted finalize retry to a read-only request.
    }
  });

  await page.goto("/");
  await page.clock.runFor(1);
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect(page.getByText("확정 상태 확인 필요", { exact: true })).toBeVisible();
  await expect.poll(() => finalizeRequests).toBe(1);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", {
      key: null,
      newValue: null,
      storageArea: window.localStorage,
      url: window.location.href,
    }));
  });
  await page.clock.runFor(600);

  await expect(page.getByText("공개 기록", { exact: true })).toBeVisible();
  await expect(page.getByText(/저장하지 못한 공개 기록/u)).toBeVisible();
  await expect.poll(() => page.evaluate(
    (storageKey) => window.localStorage.getItem(storageKey),
    key,
  )).toBeNull();
  expect(finalizeRequests).toBe(1);
  expect(readRequests).toBeGreaterThanOrEqual(1);
  releaseRecordRead();
});

test("finalizing records reconcile independently without aborting sibling requests", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS });
  await installFakeMarket(page, page, { checkedAtMs: CREATED_AT_MS });
  const records = [
    { id: "AAAAAAAAAAAAAAAG", revokeToken: "g".repeat(43) },
    { id: "AAAAAAAAAAAAAAAH", revokeToken: "h".repeat(43) },
  ];
  await page.addInitScript((values) => {
    for (const value of values) {
      window.localStorage.setItem(`${value.prefix}${value.id}`, JSON.stringify({
        id: value.id,
        revokeToken: value.revokeToken,
        verificationUrl: `${window.location.origin}/verify/?id=${value.id}`,
        lifecycle: "finalizing",
        expiresAt: new Date(value.expiresAtMs).toISOString(),
      }));
    }
  }, records.map((record) => ({
    ...record,
    expiresAtMs: RECORD_EXPIRES_AT_MS,
    prefix: MANAGED_TRADE_RECORD_STORAGE_PREFIX,
  })));

  let releaseSecond = () => {};
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const requests = new Map(records.map(({ id }) => [id, 0]));
  for (const [index, record] of records.entries()) {
    await page.route(`**/api/trade-record/${record.id}/finalize`, async (route) => {
      requests.set(record.id, (requests.get(record.id) ?? 0) + 1);
      if (index === 1) await secondGate;
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify(signedLightningRecord(record.id, record.revokeToken)),
        });
      } catch {
        // A regression with a shared controller aborts the first sibling request here.
      }
    });
  }

  await page.goto("/");
  await page.clock.runFor(1);
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(1);
  await page.clock.runFor(600);
  await expect.poll(() => requests.get(records[1].id)).toBe(1);
  releaseSecond();
  await expect(page.getByText("공개 기록", { exact: true })).toHaveCount(2);
  expect(Object.fromEntries(requests)).toEqual({
    [records[0].id]: 1,
    [records[1].id]: 1,
  });
});

test("preview stays visibly marked and hides install entry at 320px without JavaScript", async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    serviceWorkers: "block",
    viewport: { width: 320, height: 800 },
  });
  try {
    const page = await context.newPage();
    const response = await page.goto("/");
    expect(response?.headers()["x-deployment-environment"]).toBe("preview");
    expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");

    const notice = page.locator("#deployment-environment-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("PREVIEW");
    await expect(notice).toContainText("시험 환경입니다.");
    await expect(notice).not.toHaveAttribute("hidden", /.*/u);
    await expect(page.locator(".site-route-install")).toBeHidden();

    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(horizontalOverflow).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
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
  await page.clock.install({ time: CREATED_AT_MS - 60_000 });
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
  await page.clock.install({ time: CREATED_AT_MS - 60_000 });
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
  await page.clock.install({ time: CREATED_AT_MS - 60_000 });
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

test("@production-only an open verification page disables an invoice exactly when it expires", async ({ page }) => {
  await page.clock.install({ time: CREATED_AT_MS - 60_000 });
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

test("preview refuses a production-signed trade record", async ({ page }) => {
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
  await expect(page.getByText("이 기록에 사용된 공개키를 현재 앱에서 확인할 수 없습니다.")).toBeVisible();
});

test("@pwa preview removes an existing service worker and its application caches", async ({ page, context }) => {
  await installFakeMarket(page, context);
  const serviceWorkerResponse = await context.request.get("/sw.js");
  expect(serviceWorkerResponse.status()).toBe(200);
  expect(serviceWorkerResponse.headers()["cache-control"]).toContain("no-store");
  expect(serviceWorkerResponse.headers()["service-worker-allowed"]).toBe("/");
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js?stale-preview-test=1", { scope: "/" });
    await navigator.serviceWorker.ready;
    const cache = await caches.open("bitcoin-p2p-check-stale-preview-test");
    await cache.put("/stale-preview", new Response("stale"));
  });
  await page.reload();
  await expect.poll(async () => page.evaluate(async () => ({
    caches: (await caches.keys()).filter((key) => key.startsWith("bitcoin-p2p-check-")),
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
  })), { timeout: 30_000 }).toEqual({ caches: [], registrations: 0 });

  await page.reload();
  await expect(page.locator("#deployment-environment-notice")).toContainText("PREVIEW");
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
});

test("@production-pwa production registers its service worker and serves verify and 404 shells offline", async ({ page, context }) => {
  await installFakeMarket(page, context);
  await page.goto("/");
  await expect(page.locator("#deployment-environment-notice")).toBeHidden();
  await expect.poll(async () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL ?? null;
  }), { timeout: 30_000 }).toContain("/sw.js?v=2.3.0");
  await expect.poll(async () => {
    try {
      return await page.evaluate(() => navigator.serviceWorker.controller !== null);
    } catch (error) {
      // PwaRegistration intentionally reloads once on controllerchange. Retry
      // across that destroyed execution context instead of treating it as a
      // product failure.
      if (error instanceof Error && /execution context was destroyed|navigation/iu.test(error.message)) {
        return false;
      }
      throw error;
    }
  }, { timeout: 30_000 }).toBe(true);
  await page.waitForLoadState("domcontentloaded");
  await expect.poll(async () => page.evaluate(async () => (
    (await caches.keys()).some((key) => key === "bitcoin-p2p-check-precache-2.3.0")
  )), { timeout: 30_000 }).toBe(true);

  await context.setOffline(true);
  try {
    const verifyResponse = await page.goto("/verify/?id=AAAAAAAAAAAAAAAA", { waitUntil: "domcontentloaded" });
    expect(verifyResponse?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "공유된 거래 정보" })).toBeVisible();

    const notFoundResponse = await page.goto("/definitely-not-a-real-page", { waitUntil: "domcontentloaded" });
    expect(notFoundResponse?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "페이지를 찾을 수 없습니다" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
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
