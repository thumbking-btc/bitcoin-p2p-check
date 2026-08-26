import { randomBytes } from "node:crypto";
import { calculateP2PQuote } from "../app/lib/p2p-quote.mjs";
import {
  isTerminalTradeRecordRevocationError,
  revokeTradeRecord,
} from "../app/lib/trade-record-client.ts";
import {
  STAGING_TRADE_RECORD_PUBLIC_KEYS,
  verifyTradeRecordSignature,
} from "../app/lib/trade-record-verification.ts";

const STAGING_ORIGIN = "https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev";
const MAX_JSON_RESPONSE_BYTES = 65_536;

async function readBoundedJson(response) {
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json" || !response.body) {
    if (response.body) void response.body.cancel("unexpected response").catch(() => undefined);
    throw new Error("staging smoke 응답이 JSON이 아닙니다.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_JSON_RESPONSE_BYTES) {
        void reader.cancel("response too large").catch(() => undefined);
        throw new Error("staging smoke 응답이 허용 크기를 초과했습니다.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("staging smoke 응답 JSON을 확인하지 못했습니다.");
  }
}

async function jsonResponse(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...init.headers },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const value = await readBoundedJson(response);
  return { response, value };
}

function assertStatus(actual, expected, step) {
  if (actual !== expected) throw new Error(`${step} 응답이 HTTP ${actual}입니다.`);
}

function assertRecordAbsent(result, step) {
  assertStatus(result.response.status, 404, step);
  if (result.value?.ok !== false
    || result.value?.code !== "RECORD_NOT_FOUND"
    || typeof result.value?.message !== "string") {
    throw new Error(`${step} 응답이 거래 기록 API 계약과 일치하지 않습니다.`);
  }
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
  let confirmedAbsent = false;
  let operationFailure;
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
    assertRecordAbsent(pendingRead, "비공개 준비 기록 조회 차단");

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

    const revokeResult = await revokeTradeRecord(id, capability, {
      endpointBase: `${STAGING_ORIGIN}/api/trade-record`,
      timeoutMs: 20_000,
    });
    if (revokeResult.lifecycle !== "revoked") throw new Error("공개 기록 철회 응답을 확인하지 못했습니다.");

    const revokedRead = await jsonResponse(`${STAGING_ORIGIN}/api/trade-record/${encodeURIComponent(id)}`);
    assertRecordAbsent(revokedRead, "철회 기록 조회 차단");
    confirmedAbsent = true;
  } catch (error) {
    operationFailure = error;
  }

  let cleanupFailure;
  if (id && !confirmedAbsent) {
    for (let attempt = 1; attempt <= 3 && !confirmedAbsent; attempt += 1) {
      try {
        try {
          await revokeTradeRecord(id, capability, {
            endpointBase: `${STAGING_ORIGIN}/api/trade-record`,
            timeoutMs: 20_000,
          });
        } catch (error) {
          if (!isTerminalTradeRecordRevocationError(error)) throw error;
        }
        const cleanupRead = await jsonResponse(`${STAGING_ORIGIN}/api/trade-record/${encodeURIComponent(id)}`);
        assertRecordAbsent(cleanupRead, "synthetic 기록 정리 확인");
        confirmedAbsent = true;
      } catch (error) {
        cleanupFailure = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }

  if (id && !confirmedAbsent) {
    throw new AggregateError(
      [operationFailure, cleanupFailure].filter((error) => error !== undefined),
      "synthetic staging 거래 기록의 철회와 최종 부재를 확인하지 못했습니다.",
    );
  }
  if (operationFailure) throw operationFailure;
  console.log("staging synthetic 거래 기록 생성·비공개·확정·서명 조회·철회 흐름을 확인했습니다.");
}

main().catch(() => {
  console.error("staging synthetic 거래 기록 lifecycle smoke가 실패했습니다. 민감 응답은 로그에 출력하지 않았습니다.");
  process.exitCode = 1;
});
