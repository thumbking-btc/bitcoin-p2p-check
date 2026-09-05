"use client";

import { useEffect, useRef, useState } from "react";
import {
  fetchTradeRecord,
  isRetryableTradeRecordFetchError,
  TradeRecordApiRequestError,
  TradeRecordNetworkError,
} from "../lib/trade-record-client";
import { getPaymentExpiryState, isoTimeToEpochSeconds, type PaymentExpiryState } from "../lib/payment-lifecycle";
import { deriveAppliedPriceKrw, isTradeRecordId, type TradeRecord } from "../lib/trade-record";
import {
  tradeRecordPublicKeysForDeployment,
  verifyTradeRecordSignature,
  type TradeRecordVerificationResult,
} from "../lib/trade-record-verification";
import {
  inferDeploymentEnvironment,
  normalizeDeploymentEnvironment,
  normalizeOptionalDeploymentEnvironment,
} from "../lib/deployment-environment.mjs";
import { createVerifiedTextQr } from "../lib/verified-qr.mjs";
import styles from "./verify.module.css";

type ViewState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string; retryable: boolean }>
  | Readonly<{ status: "checked"; result: TradeRecordVerificationResult }>;

type VersionPayload = Readonly<{
  deploymentEnvironment?: unknown;
}>;

async function resolveVerificationDeployment(signal: AbortSignal) {
  const annotatedEnvironment = normalizeOptionalDeploymentEnvironment(
    document.documentElement.getAttribute("data-deployment-environment"),
  );
  if (annotatedEnvironment !== null) return annotatedEnvironment;

  try {
    const response = await fetch("/api/version", {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.ok) {
      const payload = await response.json() as VersionPayload;
      return normalizeDeploymentEnvironment(payload.deploymentEnvironment);
    }
  } catch (error) {
    if (signal.aborted) throw error;
  }

  return inferDeploymentEnvironment(window.location.hostname);
}

function formatKrw(value: number | string): string {
  const integer = typeof value === "string" ? BigInt(value) : BigInt(Math.round(value));
  return `${integer.toLocaleString("ko-KR")}원`;
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

function PaymentDetails({ record, paymentExpiry }: Readonly<{ record: TradeRecord; paymentExpiry: PaymentExpiryState }>) {
  const [copyStatus, setCopyStatus] = useState("");
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const paymentExpired = paymentExpiry.status === "expired";

  useEffect(() => {
    const payment = record.payment;
    const canvas = qrCanvasRef.current;
    if (!payment || paymentExpired || !canvas) return;
    const lightningInvoice = payment.rail === "lightning" && !payment.address;
    const payload = lightningInvoice ? payment.payload.toUpperCase() : payment.payload;
    const qr = createVerifiedTextQr(payload, {
      maximumLength: payment.rail === "lightning" ? 1_300 : 300,
      maximumPixelSize: 520,
      level: "M",
    });
    canvas.width = qr.width;
    canvas.height = qr.height;
    const context = canvas.getContext("2d");
    if (!context) {
      qr.data.fill(0);
      return;
    }
    const image = context.createImageData(qr.width, qr.height);
    image.data.set(qr.data);
    context.imageSmoothingEnabled = false;
    context.putImageData(image, 0, 0);
    image.data.fill(0);
    qr.data.fill(0);
    return () => {
      canvas.width = 1;
      canvas.height = 1;
    };
  }, [paymentExpired, record.payment]);

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

  const payment = record.payment;
  const onchain = payment.rail === "onchain";
  const lightningAddress = payment.rail === "lightning" && Boolean(payment.address);
  const invoiceExpiresAt = payment.rail === "lightning" && typeof payment.expiresAt === "string" ? payment.expiresAt : null;
  const onchainAmountIncluded = onchain && /^bitcoin:/iu.test(payment.payload);
  const copyTarget = onchainAmountIncluded ? payment.payload : onchain ? payment.address : payment.payload;
  async function handleCopy() {
    if (invoiceExpiresAt && getPaymentExpiryState(isoTimeToEpochSeconds(invoiceExpiresAt)).status === "expired") {
      setCopyStatus("만료된 인보이스는 복사할 수 없습니다. 수취인에게 새 인보이스를 요청하십시오.");
      return;
    }
    try {
      await copyText(copyTarget);
      setCopyStatus(onchainAmountIncluded ? "금액이 포함된 온체인 결제 URI를 복사했습니다." : onchain ? "온체인 주소를 복사했습니다." : lightningAddress ? "라이트닝 주소를 복사했습니다." : "BOLT11 인보이스를 복사했습니다.");
    } catch {
      setCopyStatus("자동 복사하지 못했습니다. 아래 내용을 길게 눌러 복사해 주세요.");
    }
  }

  return (
    <section className={`${styles.card} ${styles.paymentCard}`} aria-labelledby="shared-payment-title">
      <div className={styles.cardHeading}>
        <p>{onchain ? (onchainAmountIncluded ? "금액 포함 온체인" : "온체인 주소") : lightningAddress ? "라이트닝 주소" : "라이트닝 인보이스"}</p>
        <h2 id="shared-payment-title">BTC 결제정보</h2>
      </div>
      {paymentExpired ? (
        <div className={styles.expiredPayment} role="alert">
          <strong>이 인보이스는 만료되었습니다.</strong>
          <p>QR과 인보이스 복사를 중지했습니다. 수취인에게 현재 거래 금액의 새 인보이스를 요청하십시오.</p>
        </div>
      ) : (
        <div className={styles.copyPanel}>
          <span>{onchainAmountIncluded ? "금액 포함 온체인 결제 URI" : onchain ? "받을 주소" : lightningAddress ? "라이트닝 주소" : "BOLT11 인보이스"}</span>
          <code>{copyTarget}</code>
          <button type="button" onClick={() => void handleCopy()}>{onchainAmountIncluded ? "결제 URI 복사" : onchain || lightningAddress ? "주소 복사" : "인보이스 복사"}</button>
          <p className={styles.copyStatus} aria-live="polite">{copyStatus}</p>
        </div>
      )}
      {!paymentExpired ? (
        <details className={styles.qrDetails}>
          <summary>결제 QR 보기</summary>
          <canvas ref={qrCanvasRef} className={styles.paymentQr} aria-label={onchain ? "온체인 QR" : lightningAddress ? "라이트닝 주소 QR" : "라이트닝 결제 QR"} />
        </details>
      ) : null}
      {onchain && onchainAmountIncluded ? (
        <details className={styles.paymentExtra}>
          <summary>금액이 포함된 결제 요청 보기</summary>
          <code>{record.payment.payload}</code>
        </details>
      ) : invoiceExpiresAt ? (
        <p className={`${styles.paymentMeta} ${paymentExpiry.status === "ready" ? "" : styles.warning}`}>
          인보이스 만료: {formatTime(invoiceExpiresAt)} KST {paymentExpired ? "· 이미 만료됨" : paymentExpiry.status === "expiring" ? `· ${paymentExpiry.remainingSeconds}초 남음 · 새 인보이스를 준비하십시오` : ""}
        </p>
      ) : null}
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
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));

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
        const deploymentEnvironment = await resolveVerificationDeployment(controller.signal);
        const result = await verifyTradeRecordSignature(response, {
          publicKeys: tradeRecordPublicKeysForDeployment(deploymentEnvironment),
        });
        if (!controller.signal.aborted) setState({ status: "checked", result });
      } catch (error) {
        if (!controller.signal.aborted) {
          const notFound = error instanceof TradeRecordApiRequestError && error.status === 404;
          const offline = navigator.onLine === false || error instanceof TradeRecordNetworkError;
          setState({
            status: "error",
            message: offline
              ? "오프라인 상태에서는 거래 기록 상세를 불러올 수 없습니다. 네트워크에 연결한 뒤 다시 확인해 주세요."
              : notFound
              ? "기록을 아직 찾지 못했습니다. 생성 직후라면 저장소 전파 중일 수 있으니 잠시 후 다시 확인해 주세요."
              : error instanceof Error ? error.message : "거래 기록을 불러오지 못했습니다.",
            retryable: navigator.onLine === false || isRetryableTradeRecordFetchError(error),
          });
        }
      }
    })();
    return () => controller.abort();
  }, []);

  const verifiedRecord = state.status === "checked" && state.result.status === "valid"
    ? state.result.record
    : null;
  const invoiceExpiresAt = verifiedRecord?.payment?.rail === "lightning" && typeof verifiedRecord.payment.expiresAt === "string"
    ? verifiedRecord.payment.expiresAt
    : null;
  const invoiceExpiresAtSeconds = invoiceExpiresAt ? isoTimeToEpochSeconds(invoiceExpiresAt) : null;
  const paymentExpiry = getPaymentExpiryState(invoiceExpiresAtSeconds, nowSeconds);

  useEffect(() => {
    if (invoiceExpiresAtSeconds === null) return;
    const tick = () => setNowSeconds(Math.floor(Date.now() / 1_000));
    tick();
    const timer = window.setInterval(tick, 1_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [invoiceExpiresAtSeconds]);

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
        <strong>서명 후 기록이 바뀌지 않았습니다.</strong>
        <p>아래 정보는 이 사이트가 공유 링크를 만들 때 서명한 기록과 일치합니다.</p>
        {inferDeploymentEnvironment(typeof window === "undefined" ? "" : window.location.hostname) === "staging"
          ? <p className={styles.warning}>STAGING 시험 기록입니다. 실제 거래의 증빙으로 사용하지 마십시오.</p>
          : null}
        {state.result.recordExpired ? <p className={styles.warning}>이 공유 링크의 제공 기한이 지났습니다.</p> : null}
      </section>

      <RecordDetails record={state.result.record} />

      <aside className={styles.disclaimer}>
        <strong>확인 범위</strong>
        <p>서명은 기록 무결성만 확인합니다. 송금 전 지갑의 주소·금액을 확인하고, 실제 입금과 수령은 각자의 지갑·은행에서 확인하십시오.</p>
      </aside>

      <PaymentDetails record={state.result.record} paymentExpiry={paymentExpiry} />

      <AuditDetails record={state.result.record} />
    </div>
  );
}
