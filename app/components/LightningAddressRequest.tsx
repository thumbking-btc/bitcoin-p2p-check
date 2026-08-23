"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { MAX_BOLT11_LENGTH, validateBolt11Invoice } from "../lib/bolt11-invoice.mjs";
import { createVerifiedTextQr } from "../lib/verified-qr.mjs";
import styles from "../lightning/lightning.module.css";

type InputMode = "address" | "invoice";

type InvoiceResult = {
  address: string | null;
  canonicalInvoice: string;
  expiresAt: number;
  payeeNodeId: string;
  qr: {
    data: Uint8ClampedArray;
    height: number;
    payload: string;
    width: number;
  };
  sats: number;
};

type ApiResponse = {
  ok?: boolean;
  address?: string;
  amountSats?: number;
  invoice?: string;
  message?: string;
};

const MAX_SAFE_SATS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

function digitsOnly(value: string): string {
  return value.replace(/\D/gu, "").slice(0, 13);
}

function parseSats(value: string): number | null {
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_SAFE_SATS ? parsed : null;
}

function formatSats(value: number): string {
  return `${value.toLocaleString("ko-KR")} sats`;
}

function formatExpiry(seconds: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1_000));
}

function countdownLabel(seconds: number): string {
  if (seconds <= 0) return "만료됨";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}분 ${remainder}초 남음` : `${remainder}초 남음`;
}

function invoiceLike(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("lnbc") || normalized.startsWith("lightning:lnbc");
}

function legacyCopy(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Legacy copy is attempted below.
  }
  return legacyCopy(value);
}

export function LightningAddressRequest() {
  const [mode, setMode] = useState<InputMode>("address");
  const [satsInput, setSatsInput] = useState("100000");
  const [addressInput, setAddressInput] = useState("");
  const [invoiceInput, setInvoiceInput] = useState("");
  const [result, setResult] = useState<InvoiceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [failure, setFailure] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const resultRef = useRef<InvoiceResult | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const clearRenderedQr = useCallback(() => {
    generationRef.current += 1;
    resultRef.current?.qr.data.fill(0);
    resultRef.current = null;
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }, []);

  const clearResult = useCallback(() => {
    clearRenderedQr();
    setResult(null);
  }, [clearRenderedQr]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearRenderedQr();
    };
  }, [clearRenderedQr]);

  useLayoutEffect(() => {
    if (!result || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = result.qr.width;
    canvas.height = result.qr.height;
    const context = canvas.getContext("2d");
    if (!context) {
      clearResult();
      setFailure("QR을 화면에 표시하지 못했습니다. 다시 만드십시오.");
      return;
    }
    const pixels = context.createImageData(result.qr.width, result.qr.height);
    pixels.data.set(result.qr.data);
    context.imageSmoothingEnabled = false;
    context.putImageData(pixels, 0, 0);
    pixels.data.fill(0);
  }, [clearResult, result]);

  useEffect(() => {
    if (!result) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [result]);

  const sats = useMemo(() => parseSats(satsInput), [satsInput]);
  const remainingSeconds = result
    ? Math.max(0, result.expiresAt - Math.floor(nowMs / 1_000))
    : 0;
  const resultUsable = Boolean(result && remainingSeconds >= 1);

  function changeMode(next: InputMode) {
    if (next === mode) return;
    clearResult();
    setMode(next);
    setFeedback("");
    setFailure("");
  }

  function changeAddress(value: string) {
    if (invoiceLike(value)) {
      clearResult();
      setInvoiceInput(value);
      setAddressInput("");
      setMode("invoice");
      setFeedback("인보이스로 인식하여 직접 입력 화면으로 전환했습니다.");
      setFailure("");
      return;
    }
    clearResult();
    setAddressInput(value.slice(0, 320));
    setFeedback("");
    setFailure("");
  }

  function createResult(rawInvoice: string, resultAddress: string | null, expectedSats: number): InvoiceResult {
    const invoice = validateBolt11Invoice(rawInvoice, {
      expectedSats: BigInt(expectedSats),
      minimumRemainingSeconds: 60,
    });
    const qr = createVerifiedTextQr(invoice.canonicalInvoice.toUpperCase(), {
      maximumLength: MAX_BOLT11_LENGTH,
      maximumPixelSize: 580,
      level: "M",
    });
    return {
      address: resultAddress,
      canonicalInvoice: invoice.canonicalInvoice,
      expiresAt: invoice.expiresAt,
      payeeNodeId: invoice.payeeNodeId,
      qr,
      sats: expectedSats,
    };
  }

  async function requestAddressInvoice() {
    if (busy) return;
    if (sats === null) {
      setFailure(`받을 금액은 1~${MAX_SAFE_SATS.toLocaleString("ko-KR")} sats 범위로 입력하십시오.`);
      return;
    }
    const address = addressInput.trim();
    if (!address) {
      setFailure("라이트닝 주소를 입력하십시오.");
      return;
    }

    clearResult();
    setBusy(true);
    setFailure("");
    setFeedback("라이트닝 주소의 지갑 서비스에 금액 고정 인보이스를 요청하고 있습니다.");
    const generation = generationRef.current;

    try {
      const response = await fetch("/api/lightning-address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ address, amountSats: sats }),
      });
      const data = await response.json() as ApiResponse;
      if (!response.ok || !data.ok || typeof data.invoice !== "string" || typeof data.address !== "string") {
        throw new Error(data.message || "라이트닝 주소에서 인보이스를 만들지 못했습니다.");
      }
      if (generationRef.current !== generation || !mountedRef.current) return;

      const nextResult = createResult(data.invoice, data.address, sats);
      if (generationRef.current !== generation || !mountedRef.current) {
        nextResult.qr.data.fill(0);
        return;
      }
      resultRef.current = nextResult;
      setResult(nextResult);
      setAddressInput(data.address);
      setNowMs(Date.now());
      setFailure("");
      setFeedback("주소의 지갑 서비스가 발급한 인보이스의 서명·메인넷·금액·만료와 QR 원문을 확인했습니다.");
    } catch (error) {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setFailure(error instanceof Error ? error.message : "라이트닝 결제 요청을 만들지 못했습니다.");
      setFeedback("");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function buildDirectInvoice() {
    if (sats === null) {
      setFailure(`받을 금액은 1~${MAX_SAFE_SATS.toLocaleString("ko-KR")} sats 범위로 입력하십시오.`);
      return;
    }
    if (!invoiceInput.trim()) {
      setFailure("BOLT11 인보이스를 붙여 넣으십시오.");
      return;
    }

    clearResult();
    try {
      const nextResult = createResult(invoiceInput, null, sats);
      resultRef.current = nextResult;
      setResult(nextResult);
      setNowMs(Date.now());
      setFailure("");
      setFeedback("인보이스의 서명·메인넷·정확한 금액·만료와 QR 원문을 확인했습니다.");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "BOLT11 인보이스를 확인하지 못했습니다.");
      setFeedback("");
    }
  }

  function requestText(candidate: InvoiceResult): string {
    return [
      "[라이트닝 결제 요청]",
      `받을 금액: ${formatSats(candidate.sats)}`,
      candidate.address ? `라이트닝 주소: ${candidate.address}` : null,
      `인보이스 만료: ${formatExpiry(candidate.expiresAt)}`,
      "BOLT11:",
      candidate.canonicalInvoice,
      "결제 완료는 수취 지갑에서 직접 확인하십시오.",
    ].filter(Boolean).join("\n");
  }

  async function copyInvoice() {
    if (!result || !resultUsable) {
      setFailure("인보이스가 만료되었습니다. 새로 만드십시오.");
      return;
    }
    const copied = await copyText(result.canonicalInvoice);
    setFailure(copied ? "" : "인보이스를 복사하지 못했습니다.");
    setFeedback(copied ? "BOLT11 인보이스를 복사했습니다." : "");
  }

  async function shareRequest() {
    if (!result || !resultUsable) {
      setFailure("인보이스가 만료되었습니다. 새로 만드십시오.");
      return;
    }
    const text = requestText(result);
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: "라이트닝 결제 요청", text });
        setFeedback("공유 창으로 결제 요청을 전달했습니다.");
        setFailure("");
        return;
      }
      const copied = await copyText(text);
      setFeedback(copied ? "공유 기능을 지원하지 않아 결제 요청을 복사했습니다." : "");
      setFailure(copied ? "" : "결제 요청을 공유하거나 복사하지 못했습니다.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setFeedback("공유를 취소했습니다.");
        setFailure("");
      } else {
        setFeedback("");
        setFailure("결제 요청을 공유하지 못했습니다.");
      }
    }
  }

  async function downloadQr() {
    if (!result || !resultUsable || !canvasRef.current) {
      setFailure("현재 QR을 저장할 수 없습니다. 새로 만드십시오.");
      return;
    }
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvasRef.current?.toBlob((value) => value ? resolve(value) : reject(new Error("PNG 생성 실패")), "image/png");
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "lightning-payment-request.png";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setFeedback("QR PNG 다운로드를 시작했습니다.");
      setFailure("");
    } catch {
      setFeedback("");
      setFailure("QR PNG를 만들지 못했습니다.");
    }
  }

  function resetAll() {
    clearResult();
    setAddressInput("");
    setInvoiceInput("");
    setFeedback("");
    setFailure("");
    setBusy(false);
  }

  return (
    <section className={styles.panel} aria-labelledby="lightning-request-title">
      <header className={styles.panelHeader}>
        <div>
          <p>구매자가 BTC를 받을 때</p>
          <h2 id="lightning-request-title">라이트닝 결제 요청 만들기</h2>
        </div>
        <span>저장하지 않음</span>
      </header>

      <div className={styles.form}>
        <label className={styles.field} htmlFor="lightning-request-sats">
          <span>받을 금액</span>
          <span className={styles.amountInput}>
            <input
              id="lightning-request-sats"
              inputMode="numeric"
              value={satsInput}
              onChange={(event) => {
                clearResult();
                setSatsInput(digitsOnly(event.target.value));
                setFeedback("");
                setFailure("");
              }}
              aria-invalid={satsInput !== "" && sats === null ? true : undefined}
            />
            <b>sats</b>
          </span>
        </label>

        {mode === "address" ? (
          <label className={styles.field} htmlFor="lightning-request-address">
            <span>라이트닝 주소</span>
            <input
              id="lightning-request-address"
              className={styles.textInput}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={addressInput}
              placeholder="사용자명@도메인"
              onChange={(event) => changeAddress(event.target.value)}
            />
            <small>주소의 지갑 서비스에 위 금액의 새 인보이스를 요청합니다.</small>
          </label>
        ) : (
          <label className={styles.field} htmlFor="lightning-request-invoice">
            <span>고정금액 BOLT11 인보이스</span>
            <textarea
              id="lightning-request-invoice"
              className={styles.textarea}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={invoiceInput}
              placeholder="lnbc…"
              onChange={(event) => {
                clearResult();
                setInvoiceInput(event.target.value.slice(0, MAX_BOLT11_LENGTH));
                setFeedback("");
                setFailure("");
              }}
            />
            <small>지갑에서 위 금액으로 새로 만든 메인넷 인보이스를 입력하십시오.</small>
          </label>
        )}
      </div>

      <div className={styles.modeSwitch}>
        <span>{mode === "address" ? "지갑에서 인보이스를 이미 만들었습니까?" : "라이트닝 주소로 자동 발급받겠습니까?"}</span>
        <button type="button" onClick={() => changeMode(mode === "address" ? "invoice" : "address")}>
          {mode === "address" ? "인보이스 직접 입력" : "라이트닝 주소 사용"}
        </button>
      </div>

      <div className={styles.primaryActions}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy}
          onClick={() => mode === "address" ? void requestAddressInvoice() : buildDirectInvoice()}
        >
          {busy
            ? "인보이스 요청 중"
            : mode === "address"
              ? "금액 고정 인보이스 만들기"
              : "인보이스 확인·QR 만들기"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={resetAll}>입력 지우기</button>
      </div>

      <p className={`${styles.status} ${failure ? styles.statusError : ""}`} role={failure ? "alert" : "status"} aria-live="polite">
        {failure || feedback || "라이트닝 주소는 인보이스 자체가 아닙니다. 주소의 지갑 서비스가 이번 금액에 맞는 새 인보이스를 발급합니다."}
      </p>

      {result ? (
        <div className={`${styles.result} ${resultUsable ? "" : styles.expired}`}>
          <div className={styles.resultSummary}>
            <span>{resultUsable ? "금액 고정 인보이스 생성 완료" : "인보이스 만료"}</span>
            <strong>{formatSats(result.sats)}</strong>
            <dl>
              {result.address ? <div><dt>라이트닝 주소</dt><dd>{result.address}</dd></div> : null}
              <div><dt>인보이스 만료</dt><dd>{formatExpiry(result.expiresAt)}</dd></div>
              <div><dt>남은 시간</dt><dd>{countdownLabel(remainingSeconds)}</dd></div>
            </dl>
          </div>

          <canvas ref={canvasRef} className={styles.qr} role="img" aria-label={`${result.sats} sats 라이트닝 인보이스 QR`} />

          <details className={styles.invoiceDetails}>
            <summary>전체 BOLT11 인보이스 보기</summary>
            <code dir="ltr">{result.canonicalInvoice}</code>
          </details>

          <div className={styles.exportActions}>
            <button type="button" disabled={!resultUsable} onClick={() => void shareRequest()}>결제 요청 공유</button>
            <button type="button" disabled={!resultUsable} onClick={() => void copyInvoice()}>인보이스 복사</button>
            <button type="button" disabled={!resultUsable} onClick={() => void downloadQr()}>QR PNG 저장</button>
          </div>

          <p className={styles.resultNote}>QR은 외부 서비스로 보내지 않고 이 브라우저에서 생성·재검증합니다. 결제 완료 여부는 구매자의 수취 지갑에서 직접 확인하십시오.</p>
        </div>
      ) : null}

      <p className={styles.privacyNote}>
        라이트닝 주소와 금액은 인보이스 발급을 위해 이 프리뷰의 Cloudflare Worker와 해당 지갑 서비스로 전송됩니다. P2P 헬퍼는 이를 저장하지 않으며, 시드 문구·개인키·payment preimage는 절대 입력하지 마십시오.
      </p>
    </section>
  );
}
