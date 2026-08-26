import { randomBytes } from "node:crypto";
import { calculateP2PQuote } from "../app/lib/p2p-quote.mjs";
import {
  STAGING_TRADE_RECORD_PUBLIC_KEYS,
  verifyTradeRecordSignature,
} from "../app/lib/trade-record-verification.ts";

const STAGING_ORIGIN = "https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev";

async function jsonResponse(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const value = await response.json();
  return { response, value };
}

function assertStatus(actual, expected, step) {
  if (actual !== expected) throw new Error(`${step} 응답이 HTTP ${actual}입니다.`);
}

async function main() {
  if (process.env.STAGING_STATEFUL_TEST_APPROVED !== "true" || process.argv.length !== 2) {
    throw new Error("승인된 staging stateful smoke 문맥이 아닙니다.");
  }

  const marketResult = await jsonResponse(`${STAGING_ORIGIN}/api/market`);
  assertStatus(marketResult.response.status, 200, "시장 조회");
  const market = marketResult.value;
  if (!Number.isSafeInteger(market?.priceKrw) || typeof market.priceObservedAt !== "string") {
    throw new Error("시장 조회 응답을 거래 기록 시험에 사용할 수 없습니다.");
  }
  const quote = calculateP2PQuote({
    mode: "krw",
    amount: 100_000,
    referencePrice: market.priceKrw,
    premiumPercent: 0,
  });
  if (!quote) throw new Error("synthetic 거래 조건을 계산하지 못했습니다.");

  const capability = randomBytes(32).toString("base64url");
  let id = "";
  let revoked = false;
  try {
    const createdResult = await jsonResponse(`${STAGING_ORIGIN}/api/trade-record`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": capability,
        "X-Trade-Record-Lifecycle": "pending",
      },
      body: JSON.stringify({
        condition: {
          role: "buyer",
          amountBasis: "krw",
          bitcoinDisplayUnit: "sats",
          paymentKrw: quote.paymentKrw,
          sats: quote.sats,
          referencePriceKrw: market.priceKrw,
          marketObservedAt: market.priceObservedAt,
          koreaPremiumRatio: typeof market.koreaPremium === "number" ? market.koreaPremium : null,
          sellerPremiumBps: 0,
          fundingSource: null,
        },
        payment: null,
      }),
    });
    assertStatus(createdResult.response.status, 201, "비공개 준비 기록 생성");
    if (createdResult.value?.lifecycle !== "pending" || createdResult.value?.revokeToken !== capability) {
      throw new Error("비공개 준비 기록 응답의 관리 capability가 일치하지 않습니다.");
    }
    id = createdResult.value.id;
    if (createdResult.value.verificationUrl !== `${STAGING_ORIGIN}/verify/?id=${encodeURIComponent(id)}`) {
      throw new Error("staging 검증 URL origin이 격리 Worker와 일치하지 않습니다.");
    }

    const pendingRead = await jsonResponse(`${STAGING_ORIGIN}/api/trade-record/${encodeURIComponent(id)}`);
    assertStatus(pendingRead.response.status, 404, "비공개 준비 기록 조회 차단");

    const finalizedResult = await jsonResponse(
      `${STAGING_ORIGIN}/api/trade-record/${encodeURIComponent(id)}/finalize`,
      { method: "POST", headers: { Authorization: `Bearer ${capability}` } },
    );
    assertStatus(finalizedResult.response.status, 200, "공개 확정");
    if (finalizedResult.value?.lifecycle !== "finalized") throw new Error("공개 확정 상태가 일치하지 않습니다.");

    const publicRead = await jsonResponse(`${STAGING_ORIGIN}/api/trade-record/${encodeURIComponent(id)}`);
    assertStatus(publicRead.response.status, 200, "공개 기록 조회");
    const verification = await verifyTradeRecordSignature(publicRead.value, {
      publicKeys: STAGING_TRADE_RECORD_PUBLIC_KEYS,
    });
    if (verification.status !== "valid") throw new Error(`staging 공개 기록 서명 검증 실패: ${verification.status}`);

    const revokeResult = await jsonResponse(`${STAGING_ORIGIN}/api/trade-record/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${capability}` },
    });
    assertStatus(revokeResult.response.status, 200, "공개 기록 철회");
    revoked = true;

    const revokedRead = await jsonResponse(`${STAGING_ORIGIN}/api/trade-record/${encodeURIComponent(id)}`);
    assertStatus(revokedRead.response.status, 404, "철회 기록 조회 차단");
    console.log("staging synthetic 거래 기록 생성·비공개·확정·서명 조회·철회 흐름을 확인했습니다.");
  } finally {
    if (id && !revoked) {
      try {
        await jsonResponse(`${STAGING_ORIGIN}/api/trade-record/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${capability}` },
        });
      } catch {
        // Do not replace the original smoke failure or print the capability.
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
