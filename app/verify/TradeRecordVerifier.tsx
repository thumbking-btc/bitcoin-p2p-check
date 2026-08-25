"use client";

import { useEffect, useState } from "react";
import { fetchTradeRecord, TradeRecordApiRequestError } from "../lib/trade-record-client";
import { deriveAppliedPriceKrw, isTradeRecordId, type TradeRecord } from "../lib/trade-record";
import { verifyTradeRecordSignature, type TradeRecordVerificationResult } from "../lib/trade-record-verification";
import styles from "./verify.module.css";

type ViewState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string; retryable: boolean }>
  | Readonly<{ status: "checked"; result: TradeRecordVerificationResult }>;

function formatKrw(value: number): string {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function formatSats(value: number): string {
  return `${value.toLocaleString("ko-KR")} sats`;
}

function formatBtc(value: number): string {
  return `${(value / 100_000_000).toLocaleString("ko-KR", { maximumFractionDigits: 8 })} BTC`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatSellerPremium(basisPoints: number): string {
  const value = basisPoints / 100;
  return `${value > 0 ? "+" : ""}${value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
}

function formatKoreaPremium(value: number | null): string {
  if (value === null) return "조회 불가";
  return new Intl.NumberFormat("ko-KR", {
    style: "percent",
    signDisplay: "always",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("copy unavailable");
  await navigator.clipboard.writeText(value);
}

function PaymentDetails({ record, paymentExpired }: Readonly<{ record: TradeRecord; paymentExpired: boolean }>) {
  const [copyStatus, setCopyStatus] = useState("");
  if (!record.payment) {
    return (
      <section className={styles.card} aria-labelledby="shared-payment-title">
        <div className={styles.cardHeading}>
          <p>선택 사항</p>
          <h2 id="shared-payment-title">BTC 결제정보</h2>
        </div>
        <p className={styles.emptyPayment}>이 공유 기록에는 주소나 인보이스가 포함되지 않았습니다.</p>
      </section>
    );
  }

  const onchain = record.payment.rail === "onchain";
  const copyTarget = onchain ? record.payment.address : record.payment.payload;
  async function handleCopy() {
    try {
      await copyText(copyTarget);
      setCopyStatus(onchain ? "온체인 주소를 복사했습니다." : "BOLT11 인보이스를 복사했습니다.");
    } catch {
      setCopyStatus("자동 복사하지 못했습니다. 아래 내용을 길게 눌러 복사해 주세요.");
    }
  }

  return (
    <section className={`${styles.card} ${styles.paymentCard}`} aria-labelledby="shared-payment-title">
      <div className={styles.cardHeading}>
        <p>{onchain ? "온체인" : "라이트닝"}</p>
        <h2 id="shared-payment-title">BTC 결제정보</h2>
      </div>
      <div className={styles.copyPanel}>
        <span>{onchain ? "받을 주소" : "BOLT11 인보이스"}</span>
        <code>{copyTarget}</code>
        <button type="button" onClick={() => void handleCopy()}>{onchain ? "주소 복사" : "인보이스 복사"}</button>
        <p className={styles.copyStatus} aria-live="polite">{copyStatus}</p>
      </div>
      {onchain ? (
        <details className={styles.paymentExtra}>
          <summary>금액이 포함된 결제 요청 보기</summary>
          <code>{record.payment.payload}</code>
        </details>
      ) : (
        <p className={`${styles.paymentMeta} ${paymentExpired ? styles.warning : ""}`}>
          인보이스 만료: {formatTime(record.payment.expiresAt)} KST {paymentExpired ? "· 이미 만료됨" : ""}
        </p>
      )}
    </section>
  );
}

function RecordDetails({ record }: Readonly<{ record: TradeRecord }>) {
  const condition = record.condition;
  const bitcoinAmount = condition.bitcoinDisplayUnit === "btc" ? formatBtc(condition.sats) : formatSats(condition.sats);
  return (
    <>
      <section className={styles.card} aria-labelledby="verified-condition-title">
        <div className={styles.cardHeading}>
          <p>{condition.role === "buyer" ? "비트코인 구매" : "비트코인 판매"}</p>
          <h2 id="verified-condition-title">공유된 거래 조건</h2>
        </div>
        <dl className={styles.grid}>
          <div><dt>구매자 → 판매자</dt><dd>{formatKrw(condition.paymentKrw)}</dd></div>
          <div><dt>판매자 → 구매자</dt><dd>{bitcoinAmount}</dd></div>
          <div><dt>금액 기준</dt><dd>{condition.amountBasis === "krw" ? "원화 금액" : "비트코인 수량"}</dd></div>
          <div><dt>업비트 기준가</dt><dd>{formatKrw(condition.referencePriceKrw)} / BTC</dd></div>
          <div><dt>판매자 프리미엄</dt><dd>{formatSellerPremium(condition.sellerPremiumBps)}</dd></div>
          <div><dt>적용 단가</dt><dd>{formatKrw(deriveAppliedPriceKrw(condition))} / BTC</dd></div>
          <div><dt>업비트 프리미엄 참고</dt><dd>{formatKoreaPremium(condition.koreaPremiumRatio)}</dd></div>
          <div><dt>구매자 자금 출처</dt><dd>{condition.fundingSource ?? "기재하지 않음"}</dd></div>
          <div><dt>시세 관측 시각</dt><dd>{formatTime(condition.marketObservedAt)} KST</dd></div>
        </dl>
      </section>

    </>
  );
}

function AuditDetails({ record }: Readonly<{ record: TradeRecord }>) {
  return (
    <details className={styles.audit}>
      <summary>기록 확인 정보</summary>
      <p>상세 링크는 생성 후 180일간 제공됩니다.</p>
      <dl>
        <div><dt>기록 ID</dt><dd><code>{record.id}</code></dd></div>
        <div><dt>생성 시각</dt><dd>{formatTime(record.createdAt)} KST</dd></div>
        <div><dt>링크 제공 기한</dt><dd>{formatTime(record.expiresAt)} KST</dd></div>
      </dl>
    </details>
  );
}

export function TradeRecordVerifier() {
  const [state, setState] = useState<ViewState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const url = new URL(window.location.href);
      const ids = url.searchParams.getAll("id");
      const id = ids.length === 1 ? ids[0] : "";
      if (!isTradeRecordId(id)) {
        setState({ status: "error", message: "공유 링크의 거래 기록 ID를 확인해 주세요.", retryable: false });
        return;
      }
      try {
        const response = await fetchTradeRecord(id, { retryNotFound: true, signal: controller.signal });
        const result = await verifyTradeRecordSignature(response);
        if (!controller.signal.aborted) setState({ status: "checked", result });
      } catch (error) {
        if (!controller.signal.aborted) {
          const notFound = error instanceof TradeRecordApiRequestError && error.status === 404;
          setState({
            status: "error",
            message: notFound
              ? "기록을 아직 찾지 못했습니다. 생성 직후라면 저장소 전파 중일 수 있으니 잠시 후 다시 확인해 주세요."
              : error instanceof Error ? error.message : "거래 기록을 불러오지 못했습니다.",
            retryable: notFound,
          });
        }
      }
    })();
    return () => controller.abort();
  }, []);

  if (state.status === "loading") {
    return <section className={styles.status} role="status" aria-live="polite"><span className={styles.spinner} aria-hidden="true" />공유된 거래 정보를 불러오고 있습니다.</section>;
  }
  if (state.status === "error") {
    return (
      <section className={`${styles.status} ${styles.failure}`} role="alert">
        <strong>확인할 수 없습니다.</strong>
        <p>{state.message}</p>
        {state.retryable ? <button className={styles.retryButton} type="button" onClick={() => window.location.reload()}>다시 확인</button> : null}
      </section>
    );
  }
  if (state.result.status !== "valid") {
    return <section className={`${styles.status} ${styles.failure}`} role="alert"><strong>공유된 내용을 확인하지 못했습니다.</strong><p>{state.result.message}</p></section>;
  }

  return (
    <div className={styles.results}>
      <section className={`${styles.status} ${styles.success}`} role="status">
        <strong>공유 당시 저장된 내용과 같습니다.</strong>
        <p>아래 정보는 이 사이트가 공유 링크를 만들 때 저장한 기록과 일치합니다.</p>
        {state.result.recordExpired ? <p className={styles.warning}>이 공유 링크의 제공 기한이 지났습니다.</p> : null}
      </section>

      <PaymentDetails record={state.result.record} paymentExpired={state.result.paymentExpired} />

      <RecordDetails record={state.result.record} />

      <aside className={styles.disclaimer}>
        <strong>거래 전 확인</strong>
        <p>주소·인보이스·금액을 상대방과 지갑에서 다시 확인하고, 원화 입금과 BTC 수령 내역도 각각 확인하세요.</p>
      </aside>

      <AuditDetails record={state.result.record} />
    </div>
  );
}
