import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  calculateP2PQuote,
  MAX_KRW,
  MAX_PREMIUM_PERCENT,
  MAX_SATS,
  roundedAppliedPriceKrw,
  SATS_PER_BTC,
  stepPremiumPercent,
} from "../app/lib/p2p-quote.mjs";
import {
  isLiveStreamStalled,
  LIVE_STREAM_STALL_TIMEOUT_MS,
  markMarketPriceStale,
  mergeLiveMarketSnapshot,
  mergeRestMarketSnapshot,
} from "../app/lib/market-freshness.mjs";
import { runWithAbortTimeout } from "../app/lib/operation-timeout.mjs";
import {
  readTradeDraft,
  TRADE_DRAFT_STORAGE_KEY,
  TRADE_DRAFT_VERSION,
  writeTradeDraft,
} from "../app/lib/trade-draft.mjs";

function roundRatio(numerator, denominator) {
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

test("uses exact integer ratios across supported quote boundaries", () => {
  const prices = [1, 123_456_789, 999_999_999, MAX_KRW];
  const amounts = [1, 999_999, 1_000_000_000, 999_999_999_999];
  const premiumBpsValues = [-9_999, -123, 0, 29, 10_000, 99_999];

  for (const referencePrice of prices) {
    for (const amount of amounts) {
      for (const premiumBps of premiumBpsValues) {
        const priceNumerator = BigInt(referencePrice) * BigInt(10_000 + premiumBps);
        const expectedSats = roundRatio(
          BigInt(amount) * BigInt(SATS_PER_BTC) * 10_000n,
          priceNumerator,
        );
        const quote = calculateP2PQuote({
          mode: "krw",
          amount,
          referencePrice,
          premiumPercent: premiumBps / 100,
        });
        if (expectedSats <= 0 || expectedSats > MAX_SATS) {
          assert.equal(quote, null);
        } else {
          assert.equal(quote?.sats, expectedSats);
          assert.equal(quote?.paymentKrw, amount);
        }
      }
    }
  }

  const satsQuote = calculateP2PQuote({
    mode: "sats",
    amount: MAX_SATS,
    referencePrice: 1,
    premiumPercent: MAX_PREMIUM_PERCENT,
  });
  const expectedKrw = roundRatio(
    BigInt(MAX_SATS) * 1n * 109_999n,
    BigInt(SATS_PER_BTC) * 10_000n,
  );
  assert.equal(satsQuote?.paymentKrw, expectedKrw);
});

test("enforces the same premium and KRW boundaries as signed records", () => {
  const oneSat = calculateP2PQuote({ mode: "sats", amount: 1, referencePrice: 100_000_000, premiumPercent: 0 });
  assert.equal(oneSat?.sats, 1);
  assert.ok(calculateP2PQuote({ mode: "krw", amount: MAX_KRW, referencePrice: 100_000_000, premiumPercent: 999.99 }));
  assert.equal(calculateP2PQuote({ mode: "krw", amount: MAX_KRW + 1, referencePrice: 100_000_000, premiumPercent: 0 }), null);
  assert.equal(calculateP2PQuote({ mode: "krw", amount: 1_000_000, referencePrice: 100_000_000, premiumPercent: 1_000 }), null);
  assert.equal(calculateP2PQuote({ mode: "krw", amount: 1_000_000, referencePrice: 100_000_000.5, premiumPercent: 0 }), null);
  assert.equal(stepPremiumPercent(999.99, 1), 999.99);
  assert.equal(stepPremiumPercent(-99.99, -1), -99.99);
  assert.equal(
    roundedAppliedPriceKrw(MAX_KRW, 99_999),
    "10999899999999989",
  );
  assert.equal(
    calculateP2PQuote({ mode: "krw", amount: MAX_KRW, referencePrice: MAX_KRW, premiumPercent: 999.99 })?.appliedPriceKrw,
    "10999899999999989",
  );
});

test("marks silent or stalled market data stale without discarding the last value", () => {
  const now = Date.parse("2026-08-25T00:00:30.000Z");
  assert.equal(isLiveStreamStalled(now - LIVE_STREAM_STALL_TIMEOUT_MS + 1, now), false);
  assert.equal(isLiveStreamStalled(now - LIVE_STREAM_STALL_TIMEOUT_MS, now), true);
  assert.equal(isLiveStreamStalled(0, now), true);

  const snapshot = {
    status: "current",
    priceKrw: 123_456_789,
    priceObservedAt: "2026-08-25T00:00:00.000Z",
    sourceStatus: { price: "current", premium: "current", fees: "current" },
    staleAgeSeconds: { price: null, premium: null, fees: null },
  };
  const stale = markMarketPriceStale(snapshot, now);
  assert.equal(stale.priceKrw, snapshot.priceKrw);
  assert.equal(stale.status, "stale");
  assert.equal(stale.sourceStatus.price, "stale");
  assert.equal(stale.staleAgeSeconds.price, 30);
  assert.equal(snapshot.status, "current");
});

test("accumulates deferred REST and WebSocket fields from the latest locked snapshot", () => {
  const initial = {
    status: "current",
    priceKrw: 100_000_000,
    priceObservedAt: "2026-08-25T00:00:00.000Z",
    koreaPremium: 0.01,
    feeRates: { nextBlock: 10, halfHour: 8, hour: 5 },
    sourceStatus: { price: "current", premium: "current", fees: "current" },
    staleAgeSeconds: { price: null, premium: null, fees: null },
  };
  const firstLive = mergeLiveMarketSnapshot(initial, {
    priceKrw: 101_000_000,
    observedAtMs: Date.parse("2026-08-25T00:00:01.000Z"),
  });
  const restRefresh = {
    ...initial,
    status: "partial",
    priceKrw: null,
    priceObservedAt: null,
    koreaPremium: 0.02,
    feeRates: { nextBlock: 20, halfHour: 16, hour: 12 },
    sourceStatus: { price: "unavailable", premium: "current", fees: "current" },
  };
  const afterRest = mergeRestMarketSnapshot(restRefresh, firstLive, true);
  assert.equal(afterRest.priceKrw, 101_000_000);
  assert.equal(afterRest.priceObservedAt, "2026-08-25T00:00:01.000Z");
  assert.deepEqual(afterRest.feeRates, restRefresh.feeRates);
  assert.equal(afterRest.koreaPremium, 0.02);

  const afterSecondLive = mergeLiveMarketSnapshot(afterRest, {
    priceKrw: 102_000_000,
    observedAtMs: Date.parse("2026-08-25T00:00:02.000Z"),
  });
  assert.equal(afterSecondLive.priceKrw, 102_000_000);
  assert.deepEqual(afterSecondLive.feeRates, restRefresh.feeRates);
  assert.equal(afterSecondLive.koreaPremium, 0.02);
  assert.equal(mergeLiveMarketSnapshot(afterSecondLive, {
    priceKrw: 99_000_000,
    observedAtMs: Date.parse("2026-08-25T00:00:01.500Z"),
  }), afterSecondLive, "an older live tick must not replace the accumulated deferred snapshot");
});

test("aborts operations at a bounded deadline and preserves ordinary failures", async () => {
  await assert.rejects(
    runWithAbortTimeout(
      (signal) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      5,
      "시간 초과",
    ),
    /시간 초과/,
  );
  await assert.rejects(
    runWithAbortTimeout(async () => { throw new Error("원래 오류"); }, 1_000, "시간 초과"),
    /원래 오류/,
  );
  assert.equal(await runWithAbortTimeout(async () => 42, 1_000, "시간 초과"), 42);
});

test("drops funding sources while migrating version 3 browser drafts", () => {
  const now = 1_800_000_000_000;
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const fields = {
    tradeRole: "buyer",
    krwAmounts: { buyer: "3000000", seller: "3000000" },
    bitcoinAmountInputs: { buyer: "3000000", seller: "3000000" },
    amountBasisByRole: { buyer: "krw", seller: "bitcoin" },
    premiumInput: "0",
    fundingSource: "근로소득",
    bitcoinDisplayUnit: "sats",
  };
  assert.equal(writeTradeDraft(storage, fields, now), true);
  assert.equal(Object.hasOwn(JSON.parse(values.get(TRADE_DRAFT_STORAGE_KEY)), "fundingSource"), false);

  values.set(TRADE_DRAFT_STORAGE_KEY, JSON.stringify({
    version: 3,
    savedAt: now,
    ...fields,
  }));
  const migrated = readTradeDraft(storage, now);
  assert.equal(migrated.version, TRADE_DRAFT_VERSION);
  assert.equal(Object.hasOwn(migrated, "fundingSource"), false);
  assert.equal(Object.hasOwn(JSON.parse(values.get(TRADE_DRAFT_STORAGE_KEY)), "fundingSource"), false);
});

test("explains local deletion and public-link deactivation without conflating them", async () => {
  const privacy = await readFile(new URL("../app/privacy/page.tsx", import.meta.url), "utf8");

  assert.match(privacy, /공개 링크가 있으면 누구나 로그인 없이 최대 180일간 기록을 볼 수 있습니다/);
  assert.match(privacy, /일반적인 초안 변경과 이 버튼으로 한 삭제가 동기화됩니다/);
  assert.match(privacy, /브라우저 사이트 데이터를 삭제하면 이 관리 정보는 사라지지만 서버의 공개 기록은 비활성화되지 않습니다/);
  assert.match(privacy, /공개 기록이 있으면 먼저 거래 기록 관리에서 <strong>공개 링크 비활성화<\/strong>/);
  assert.match(privacy, /비활성화하기 전에 관리 정보를 지우고 관련 탭까지 닫으면 나중에 관리 권한을 복구할 수 없습니다/);
  assert.match(privacy, /같은 관리 정보의 재사용을 막기 위한 최소 상태값만 보관 기간 동안 남습니다/);
  assert.doesNotMatch(privacy, /사이트 데이터를 삭제하면 제거됩니다\. 같은 사이트를 연 다른 탭에는 삭제·변경 사실이 동기화됩니다/);
  assert.doesNotMatch(privacy, /철회 권한|공개 기록 철회/);
});

test("wires calculator hardening states into the client component", async () => {
  const [component, shareSession, styles] = await Promise.all([
    readFile(new URL("../app/components/P2PTradeTool.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-share-session.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /aria-live=\{resultLiveMode\}[\s\S]*?\{currentResultAnnouncement\}/);
  assert.doesNotMatch(component, /resultAnnouncement \|\| currentResultAnnouncement/);
  assert.match(component, /isLiveStreamStalled\(lastMessageAt\)/);
  assert.match(component, /markMarketStale\(refresh\.mode === "silent"/);
  assert.match(component, /createPendingTradeRecord\(tradeRecordDraft, \{[\s\S]*?revokeToken: attempt\.revokeToken,[\s\S]*?timeoutMs: TRADE_RECORD_CREATE_TIMEOUT_MS/);
  assert.match(component, /matchingShareAttempt\(shareAttemptCacheRef\.current, shareAttemptKey\)[\s\S]*?createShareAttempt\(shareAttemptKey, createTradeRecordRevokeToken\(\)\)/);
  assert.match(shareSession, /current\?\.key === key \? current : null/);
  const prepareBlock = component.slice(component.indexOf("async function prepareTradeShare"), component.indexOf("async function sharePreparedTrade"));
  const deliveryBlock = component.slice(component.indexOf("async function sharePreparedTrade"), component.indexOf("async function cancelPreparedTrade"));
  assert.match(prepareBlock, /createPendingTradeRecord\([\s\S]*?materializeTradeShareImage\([\s\S]*?const preparationStillSafe/);
  assert.doesNotMatch(prepareBlock, /finalizeTradeRecord\(/);
  assert.ok(deliveryBlock.indexOf("await shareImageFile") < deliveryBlock.indexOf("await finalizeTradeRecord"));
  assert.match(deliveryBlock, /outcome === "cancelled"[\s\S]*?revokeKnownRecord\(/);
  assert.match(deliveryBlock, /const finalizationStillSafe[\s\S]*?finalizeTradeRecord\([\s\S]*?const finalizationRemainsSafe/);
  assert.ok(
    deliveryBlock.indexOf("const pendingCapabilityPersisted") < deliveryBlock.indexOf("await finalizeTradeRecord"),
    "the pending revoke capability must be persisted before the server finalization request",
  );
  assert.match(deliveryBlock, /toManagedTradeRecord\(activePrepared\.signed, activePrepared\.revokeToken, "finalizing"\)/);
  assert.match(deliveryBlock, /if \(!pendingCapabilityPersisted\)[\s\S]*?공개 확정을 시작하지 않았습니다[\s\S]*?return;/);
  assert.match(deliveryBlock, /stage === "sharing"[\s\S]*?toManagedTradeRecord\(activePrepared\.signed, activePrepared\.revokeToken\)/);
  assert.match(shareSession, /signed\.lifecycle \?\? "pending"/);
  assert.match(deliveryBlock, /카드는 전달되었지만 상세 기록을 공개 확정하지 못했습니다/);
  assert.match(component, /preparedShareIsCurrent[\s\S]*?sharePreparedTrade\(\)[\s\S]*?prepareTradeShare\(\)/);
  assert.match(component, /cancelPreparedTrade[\s\S]*?revokeKnownRecord\(/);
  assert.match(component, /managedTradeRecords[\s\S]*?revokeManagedTradeRecord/);
  assert.match(component, /onLifecycleChange=\{handleReceiveInfoLifecycle\}/);
  assert.match(component, /paymentLifecycleBlocksShare/);
  assert.match(component, /if \(state\.status !== "empty"\)[\s\S]*?paymentLockRef\.current = true[\s\S]*?paymentLockRef\.current = false/);
  assert.match(component, /window\.addEventListener\("storage", handleStorage\)/);
  assert.match(component, /자금 출처는 저장하지 않습니다/);
  assert.match(component, /function changeTradeRole[\s\S]*?현재 거래 금액과 입력 단위를 유지했습니다/);
  assert.doesNotMatch(component, /<label className="field" htmlFor="seller-premium">/);
  assert.match(component, /1 sat은 Lightning에서 전송 가능한 단위이지만[\s\S]*?온체인에서는 dust 기준에 미달할 수 있고 네트워크 수수료가 거래액을 넘을 수 있습니다/);
  assert.match(component, /id="tiny-trade-warning" role="status"/);
  assert.match(component, /공유 링크가 있으면 누구나 로그인 없이 최대 180일간 기록을 볼 수 있습니다/);
  assert.doesNotMatch(component, /공개 확정 전에 철회 권한을 먼저 브라우저에 저장/);
  assert.match(component, /이 브라우저에서 만든 기록과 공개 링크를 관리합니다/);
  assert.doesNotMatch(component, /공개 기록은 만료 시까지 관리합니다/);
  assert.match(component, /링크 열기/);
  assert.match(component, /링크 복사/);
  assert.match(component, /공개 링크 비활성화/);
  assert.doesNotMatch(component, />열기<|>복사<|>철회</);
  assert.match(styles, /\.managed-record-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.managed-record-action\s*\{[^}]*min-height:\s*44px/);
  assert.match(styles, /\.managed-record-action\.is-destructive\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(component, /loadPersistedManagedTradeRecords/);
  assert.match(component, /persistManagedTradeRecord/);
  assert.match(component, /MANAGED_TRADE_RECORD_STORAGE_PREFIX/);
  assert.match(component, /const capabilityPersisted = rememberManagedRecord\(finalizedRecord\);[\s\S]*?if \(!capabilityPersisted\)/);
  assert.match(component, /parseManagedTradeRecordStorageKey\(event\.key\)/);
  assert.match(component, /record\.persistence === "browser"[\s\S]*?finalizeTradeRecord\(record\.id, record\.revokeToken[\s\S]*?: await fetchTradeRecord\(record\.id/);
  const reconciliationBlock = component.slice(
    component.indexOf("const handleFinalizingRecordFinalized"),
    component.indexOf("const handleFinalizingRecordMissing"),
  );
  assert.ok(
    reconciliationBlock.indexOf("removedManagedRecordIdsRef.current.has")
      < reconciliationBlock.indexOf("reconciliationStorageGeneration !== managedStorageGenerationRef.current"),
    "a removal tombstone must win over a late reconciliation completion",
  );
  assert.match(component, /event\.key === null[\s\S]*?knownManagedRecordIdsRef[\s\S]*?removePersistedManagedTradeRecord\(storage, recordId\)/);
  assert.match(component, /event\.key === null[\s\S]*?keepKnownRecordInMemory\(recordId\)/);
  assert.match(component, /removedManagedRecordIdsRef\.current\.add\(record\.id\);[\s\S]*?knownManagedRecordsRef\.current\.delete\(record\.id\)/);
  assert.match(component, /managedTradeRecordCleanupAt\(record\)[\s\S]*?pruneExpiredManagedTradeRecords/);
  assert.match(shareSession, /managedTradeRecordPendingExpiresAt\(record\) \?\? record\.expiresAt/);
  assert.match(component, /confirmedMissing[\s\S]*?record\.persistence === "browser"[\s\S]*?managedTradeRecordCleanupAt\(record\) <= Date\.now\(\)/);
  assert.match(component, /managedTradeRecordDisplayDeadline\(record\)[\s\S]*?확인 기한/);
  assert.doesNotMatch(component, /managedTradeRecordPendingExpiresAt\(record\)[\s\S]*?Date\.now\(\)/);
  assert.match(component, /removedManagedRecordIdsRef[\s\S]*?storage\.removeItem\(event\.key\)/);
  assert.match(component, /const confirmationMessage[\s\S]*?되돌릴 수 없습니다[\s\S]*?window\.confirm\(confirmationMessage\)/);
  assert.doesNotMatch(component, /setItem\(MANAGED_TRADE_RECORD_STORAGE_KEY/);
  assert.match(styles, /\.managed-trade-records > p\.is-error \{[^}]*color: var\(--red\)/);
  assert.match(component, /href="\/privacy\/"/);
  assert.match(styles, /\.premium-stepper \{[^}]*width: 88px;[^}]*grid-template-columns: repeat\(2, 44px\)/);
  assert.match(styles, /\.premium-stepper button \{[^}]*min-width: 44px;[^}]*min-height: 44px/);
  assert.doesNotMatch(styles, /\.premium-stepper button \{[^}]*min-width: (?:24|28)px/);
});
