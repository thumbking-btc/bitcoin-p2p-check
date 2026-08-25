import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getPaymentExpiryState,
  isoTimeToEpochSeconds,
  PAYMENT_EXPIRING_THRESHOLD_SECONDS,
} from "../app/lib/payment-lifecycle.ts";
import { shareImageFile } from "../app/lib/share-transport.mjs";

test("classifies the 121 to 119 second invoice transition against an explicit clock", () => {
  const nowSeconds = 1_800_000_000;
  const expiresAtSeconds = nowSeconds + 121;

  assert.equal(PAYMENT_EXPIRING_THRESHOLD_SECONDS, 120);
  assert.deepEqual(getPaymentExpiryState(expiresAtSeconds, nowSeconds), {
    status: "ready",
    expiresAtSeconds,
    remainingSeconds: 121,
  });
  assert.equal(getPaymentExpiryState(expiresAtSeconds, nowSeconds + 1).status, "ready");
  assert.deepEqual(getPaymentExpiryState(expiresAtSeconds, nowSeconds + 2), {
    status: "expiring",
    expiresAtSeconds,
    remainingSeconds: 119,
  });
  assert.deepEqual(getPaymentExpiryState(expiresAtSeconds, expiresAtSeconds), {
    status: "expired",
    expiresAtSeconds,
    remainingSeconds: 0,
  });
});

test("supports non-expiring payments and canonical ISO expiry clocks", () => {
  assert.deepEqual(getPaymentExpiryState(null, 1_800_000_000), {
    status: "no-expiry",
    expiresAtSeconds: null,
    remainingSeconds: null,
  });
  assert.equal(isoTimeToEpochSeconds("2027-01-15T08:00:00.000Z"), 1_800_000_000);
  assert.throws(() => getPaymentExpiryState(0, 1_800_000_000), /positive safe integer/u);
  assert.throws(() => isoTimeToEpochSeconds("not-a-time"), /invalid/u);
});

test("download fallback carries the verification URL through a separate delivery channel", async () => {
  const file = { name: "trade.png", type: "image/png" };
  const copied = [];
  const downloads = [];
  const fallbackEvents = [];
  const verificationUrl = "https://example.test/verify?id=record";

  const outcome = await shareImageFile({
    file,
    title: "거래 기록",
    text: "거래 조건",
    nativeCanShare: () => false,
    nativeShare: async () => { throw new Error("must not run"); },
    download: (value) => downloads.push(value),
    verificationUrl,
    copyVerificationUrl: async (value) => copied.push(value),
    onDownloadFallback: async (event) => fallbackEvents.push(event),
  });

  assert.equal(outcome, "downloaded");
  assert.deepEqual(downloads, [file]);
  assert.deepEqual(copied, [verificationUrl]);
  assert.deepEqual(fallbackEvents, [{
    outcome: "downloaded",
    verificationUrl,
    verificationUrlDelivery: "copied",
  }]);
});

test("payment UIs expose lifecycle warnings and no longer make the static card look interactive", async () => {
  const [portal, verifier, image] = await Promise.all([
    readFile(new URL("../app/components/TradeReceiveInfoPortal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/verify/TradeRecordVerifier.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-share-image.ts", import.meta.url), "utf8"),
  ]);

  assert.match(portal, /status: "expiring" \| "expired"/u);
  assert.match(portal, /지갑에서 새 인보이스를 만들어 다시 확인하십시오/u);
  assert.match(verifier, /document\.addEventListener\("visibilitychange"/u);
  assert.match(verifier, /QR과 인보이스 복사를 중지했습니다/u);
  assert.match(verifier, /상대방의 신원, 원화 입금, BTC 수령 또는 거래 완료를 보증하지 않습니다/u);
  assert.match(image, /절대 만료/u);
  assert.match(image, /QR에는 결제 금액이 포함되지 않음/u);
  assert.doesNotMatch(image, /공유 정보 보기/u);
});
