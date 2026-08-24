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

function RecordDetails({ record, paymentExpired }: Readonly<{ record: TradeRecord; paymentExpired: boolean }>) {
  const condition = record.condition;
  const bitcoinAmount = condition.bitcoinDisplayUnit === "btc" ? formatBtc(condition.sats) : formatSats(condition.sats);
  return (
    <>
      <section className={styles.card} aria-labelledby="verified-condition-title">
        <div className={styles.cardHeading}>
          <p>{condition.role === "buyer" ? "비트코인 구매" : "비트코인 판매"}</p>
          <h2 id="verified-condition-title">서명된 거래 조건</h2>
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

      {record.payment ? (
        <section className={styles.card} aria-labelledby="verified-payment-title">
          <div className={styles.cardHeading}>
            <p>{record.payment.rail === "onchain" ? "온체인" : "라이트닝"}</p>
            <h2 id="verified-payment-title">서명된 BTC 수취정보</h2>
          </div>
          {record.payment.rail === "onchain" ? (
            <dl className={styles.paymentList}>
              <div><dt>주소</dt><dd><code>{record.payment.address}</code></dd></div>
              <div><dt>BIP21</dt><dd><code>{record.payment.payload}</code></dd></div>
            </dl>
          ) : (
            <dl className={styles.paymentList}>
              <div><dt>인보이스 만료</dt><dd>{formatTime(record.payment.expiresAt)} KST {paymentExpired ? "· 이미 만료됨" : ""}</dd></div>
              <div><dt>BOLT11</dt><dd><code>{record.payment.payload}</code></dd></div>
            </dl>
          )}
        </section>
      ) : null}

      <section className={styles.audit} aria-label="기록 정보">
        <dl>
          <div><dt>기록 ID</dt><dd><code>{record.id}</code></dd></div>
          <div><dt>생성 시각</dt><dd>{formatTime(record.createdAt)} KST</dd></div>
          <div><dt>보관 기한</dt><dd>{formatTime(record.expiresAt)} KST</dd></div>
        </dl>
      </section>
    </>
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
        setState({ status: "error", message: "검증 링크의 거래 기록 ID를 확인해 주세요.", retryable: false });
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
    return <section className={styles.status} role="status" aria-live="polite"><span className={styles.spinner} aria-hidden="true" />서명된 거래 기록을 확인하고 있습니다.</section>;
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
    return <section className={`${styles.status} ${styles.failure}`} role="alert"><strong>서명을 확인하지 못했습니다.</strong><p>{state.result.message}</p></section>;
  }

  return (
    <div className={styles.results}>
      <section className={`${styles.status} ${styles.success}`} role="status">
        <strong>원본 서명이 확인됐습니다.</strong>
        <p>이 기록은 이 사이트의 서명 키로 서명되었고, 서명 이후 내용이 변경되지 않았습니다.</p>
        {state.result.recordExpired ? <p className={styles.warning}>기록의 180일 보관 기한은 지났습니다.</p> : null}
      </section>

      <aside className={styles.disclaimer}>
        <strong>이 서명이 증명하지 않는 것</strong>
        <p>기준 시세·프리미엄 참고값의 정확성이나 실제 업비트 관측 여부, 거래 당사자의 합의·신원, 원화 입금, BTC 전송·수령, 인보이스 결제 또는 거래 완료를 증명하지 않습니다. 표시된 기록의 사이트 서명·무변경 여부만 확인합니다.</p>
      </aside>

      <RecordDetails record={state.result.record} paymentExpired={state.result.paymentExpired} />
    </div>
  );
}
