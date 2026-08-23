"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { MAX_BOLT11_LENGTH, validateBolt11Invoice } from "../lib/bolt11-invoice.mjs";
import { createOnchainRequest, MAX_ONCHAIN_REQUEST_SATS } from "../lib/onchain-request.mjs";
import { createVerifiedTextQr } from "../lib/verified-qr.mjs";
import styles from "../lightning/lightning.module.css";

type PaymentRail = "onchain" | "lightning";
type LightningInputMode = "address" | "invoice";

type QrArtifact = {
  data: Uint8ClampedArray;
  height: number;
  payload: string;
  width: number;
};

type OnchainResult = {
  rail: "onchain";
  address: string;
  btcAmount: string;
  requestPayload: string;
  sats: number;
  scriptType: string;
  qr: QrArtifact;
};

type LightningResult = {
  rail: "lightning";
  address: string | null;
  canonicalInvoice: string;
  expiresAt: number;
  sats: number;
  qr: QrArtifact;
};

type RequestResult = OnchainResult | LightningResult;

type ApiResponse = {
  ok?: boolean;
  address?: string;
  amountSats?: number;
  invoice?: string;
  message?: string;
};

const MAX_REQUEST_SATS = Number(MAX_ONCHAIN_REQUEST_SATS);

function digitsOnly(value: string): string {
  return value.replace(/\D/gu, "").slice(0, 16);
}

function parseSats(value: string): number | null {
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_REQUEST_SATS ? parsed : null;
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

function friendlyError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (
    !message
    || /did not match the expected pattern/iu.test(message)
    || /unexpected token/iu.test(message)
    || /^syntaxerror/iu.test(message)
  ) {
    return fallback;
  }
  return message;
}

function legacyCopy(value: string): boolean {
  const textarea = document.createElement("textarea");
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  try {
    document.body.append(textarea);
    textarea.select();
    return document.execCommand("copy");
  } finally {
    textarea.remove();
    try {
      previousFocus?.focus({ preventScroll: true });
    } catch {
      try {
        previousFocus?.focus();
      } catch {
        // 복사 결과를 포커스 복원 실패로 바꾸지 않습니다.
      }
    }
  }
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 구형 복사 방식으로 한 번 더 시도합니다.
  }
  return legacyCopy(value);
}

async function readApiResponse(response: Response): Promise<ApiResponse> {
  const text = await response.text();
  if (!text) {
    throw new Error("라이트닝 주소 요청 서버가 빈 응답을 반환했습니다. 새로고침 후 다시 시도하십시오.");
  }
  try {
    return JSON.parse(text) as ApiResponse;
  } catch {
    throw new Error("라이트닝 주소 요청 서버의 응답을 읽지 못했습니다. 새로고침 후 다시 시도하십시오.");
  }
}

function resultPayload(result: RequestResult): string {
  return result.rail === "onchain" ? result.requestPayload : result.canonicalInvoice;
}

function resultFileName(result: RequestResult): string {
  return result.rail === "onchain"
    ? "bitcoin-onchain-payment-request.png"
    : "bitcoin-lightning-payment-request.png";
}

function resultShareTitle(result: RequestResult): string {
  return result.rail === "onchain" ? "온체인 BTC 송금 요청" : "라이트닝 BTC 송금 요청";
}

export function LightningAddressRequest() {
  const [rail, setRail] = useState<PaymentRail>("onchain");
  const [lightningMode, setLightningMode] = useState<LightningInputMode>("address");
  const [satsInput, setSatsInput] = useState("100000");
  const [onchainAddressInput, setOnchainAddressInput] = useState("");
  const [lightningAddressInput, setLightningAddressInput] = useState("");
  const [invoiceInput, setInvoiceInput] = useState("");
  const [result, setResult] = useState<RequestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [failure, setFailure] = useState("");
  const [nowMs, setNowMs] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const resultRef = useRef<RequestResult | null>(null);
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
    setNowMs(0);
  }, [clearRenderedQr]);

  useEffect(() => {
    const syncPreviewMode = () => {
      const previewActive = window.location.hash === "#lightning-preview"
        || window.location.hash === "#payment-request-preview";
      document.documentElement.classList.toggle("payment-request-preview-active", previewActive);
    };
    syncPreviewMode();
    window.addEventListener("hashchange", syncPreviewMode);
    return () => {
      window.removeEventListener("hashchange", syncPreviewMode);
      document.documentElement.classList.remove("payment-request-preview-active");
    };
  }, []);

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
    if (!result || result.rail !== "lightning") return;
    const tick = () => setNowMs(Date.now());
    const kickoff = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1_000);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(timer);
    };
  }, [result]);

  const sats = useMemo(() => parseSats(satsInput), [satsInput]);
  const remainingSeconds = result?.rail === "lightning" && nowMs > 0
    ? Math.max(0, result.expiresAt - Math.floor(nowMs / 1_000))
    : 0;
  const resultUsable = Boolean(
    result && (result.rail === "onchain" || remainingSeconds > 0),
  );

  function resetMessages() {
    setFeedback("");
    setFailure("");
  }

  function changeRail(next: PaymentRail) {
    if (next === rail) return;
    clearResult();
    setRail(next);
    if (next === "lightning") setLightningMode("address");
    resetMessages();
  }

  function changeLightningMode(next: LightningInputMode) {
    if (next === lightningMode) return;
    clearResult();
    setLightningMode(next);
    resetMessages();
  }

  function changeLightningAddress(value: string) {
    if (invoiceLike(value)) {
      clearResult();
      setInvoiceInput(value);
      setLightningAddressInput("");
      setLightningMode("invoice");
      setFeedback("인보이스로 인식하여 직접 입력 화면으로 전환했습니다.");
      setFailure("");
      return;
    }
    clearResult();
    setLightningAddressInput(value.slice(0, 320));
    resetMessages();
  }

  function buildOnchainRequest() {
    if (sats === null) {
      setFailure(`받을 금액은 1~${MAX_REQUEST_SATS.toLocaleString("ko-KR")} sats 범위로 입력하십시오.`);
      return;
    }
    const address = onchainAddressInput.trim();
    if (!address) {
      setFailure("온체인 수취 주소를 입력하십시오.");
      return;
    }

    clearResult();
    try {
      const request = createOnchainRequest(address, BigInt(sats));
      const qr = createVerifiedTextQr(request.uri, {
        maximumLength: 220,
        maximumPixelSize: 580,
        level: "M",
      });
      const nextResult: OnchainResult = {
        rail: "onchain",
        address: request.address,
        btcAmount: request.btcAmount,
        requestPayload: request.uri,
        sats,
        scriptType: request.scriptType,
        qr,
      };
      resultRef.current = nextResult;
      setResult(nextResult);
      setOnchainAddressInput(request.address);
      setFailure("");
      setFeedback("메인넷 주소와 금액을 확인하고 BIP21 QR을 만들었습니다.");
    } catch (error) {
      setFailure(friendlyError(error, "온체인 주소 또는 결제 요청 형식을 확인하지 못했습니다."));
      setFeedback("");
    }
  }

  function createLightningResult(
    rawInvoice: string,
    resultAddress: string | null,
    expectedSats: number,
  ): LightningResult {
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
      rail: "lightning",
      address: resultAddress,
      canonicalInvoice: invoice.canonicalInvoice,
      expiresAt: invoice.expiresAt,
      qr,
      sats: expectedSats,
    };
  }

  async function requestAddressInvoice() {
    if (busy) return;
    if (sats === null) {
      setFailure(`받을 금액은 1~${MAX_REQUEST_SATS.toLocaleString("ko-KR")} sats 범위로 입력하십시오.`);
      return;
    }
    const address = lightningAddressInput.trim();
    if (!address) {
      setFailure("라이트닝 주소를 입력하십시오.");
      return;
    }

    clearResult();
    setBusy(true);
    setFailure("");
    setFeedback("라이트닝 주소의 지갑 서비스에 금액 고정 인보이스를 요청하고 있습니다.");
    const generation = generationRef.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch("/api/lightning-address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({ address, amountSats: sats }),
      });
      const data = await readApiResponse(response);
      if (
        !response.ok
        || !data.ok
        || typeof data.invoice !== "string"
        || typeof data.address !== "string"
        || data.amountSats !== sats
      ) {
        throw new Error(data.message || "라이트닝 주소에서 인보이스를 만들지 못했습니다.");
      }
      if (generationRef.current !== generation || !mountedRef.current) return;

      const nextResult = createLightningResult(data.invoice, data.address, sats);
      if (generationRef.current !== generation || !mountedRef.current) {
        nextResult.qr.data.fill(0);
        return;
      }
      resultRef.current = nextResult;
      setResult(nextResult);
      setLightningAddressInput(data.address);
      setNowMs(Date.now());
      setFailure("");
      setFeedback("주소의 지갑 서비스가 발급한 인보이스의 메인넷·금액·만료와 QR 원문을 확인했습니다.");
    } catch (error) {
      if (!mountedRef.current || generationRef.current !== generation) return;
      const fallback = controller.signal.aborted
        ? "라이트닝 주소 제공자의 응답 시간이 초과되었습니다. 다시 시도하거나 인보이스를 직접 입력하십시오."
        : "라이트닝 주소에서 인보이스를 만들지 못했습니다. 다시 시도하거나 인보이스를 직접 입력하십시오.";
      setFailure(friendlyError(error, fallback));
      setFeedback("");
    } finally {
      window.clearTimeout(timeout);
      if (mountedRef.current) setBusy(false);
    }
  }

  function buildDirectInvoice() {
    if (sats === null) {
      setFailure(`받을 금액은 1~${MAX_REQUEST_SATS.toLocaleString("ko-KR")} sats 범위로 입력하십시오.`);
      return;
    }
    if (!invoiceInput.trim()) {
      setFailure("BOLT11 인보이스를 붙여 넣으십시오.");
      return;
    }

    clearResult();
    try {
      const nextResult = createLightningResult(invoiceInput, null, sats);
      resultRef.current = nextResult;
      setResult(nextResult);
      setNowMs(Date.now());
      setFailure("");
      setFeedback("인보이스의 메인넷·정확한 금액·만료와 QR 원문을 확인했습니다.");
    } catch (error) {
      setFailure(friendlyError(error, "BOLT11 인보이스 형식을 확인하지 못했습니다."));
      setFeedback("");
    }
  }

  function requestText(candidate: RequestResult): string {
    if (candidate.rail === "onchain") {
      return [
        "[BTC 송금 요청 · 온체인]",
        `받을 금액: ${formatSats(candidate.sats)} (${candidate.btcAmount} BTC)`,
        `받을 주소: ${candidate.address}`,
        `주소·금액 URI: ${candidate.requestPayload}`,
        "채굴 수수료는 보내는 사람이 별도로 부담합니다.",
        "수취 완료는 구매자 지갑에서 직접 확인하십시오.",
      ].join("\n");
    }

    return [
      "[BTC 송금 요청 · 라이트닝]",
      `받을 금액: ${formatSats(candidate.sats)}`,
      candidate.address ? `라이트닝 주소: ${candidate.address}` : null,
      `인보이스 만료: ${formatExpiry(candidate.expiresAt)}`,
      "BOLT11:",
      candidate.canonicalInvoice,
      "라우팅 수수료는 보내는 사람이 결제 전에 확인합니다.",
      "수취 완료는 구매자 지갑에서 직접 확인하십시오.",
    ].filter(Boolean).join("\n");
  }

  async function canvasPngFile(candidate: RequestResult): Promise<File> {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("QR 화면이 없습니다.");
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("QR PNG 생성 실패")),
        "image/png",
      );
    });
    return new File([blob], resultFileName(candidate), {
      type: "image/png",
      lastModified: Date.now(),
    });
  }

  async function copyPayload() {
    if (!result || !resultUsable) {
      setFailure("현재 결제 요청을 복사할 수 없습니다. 새로 만드십시오.");
      return;
    }
    const copied = await copyText(resultPayload(result));
    setFailure(copied ? "" : "결제 요청을 복사하지 못했습니다.");
    setFeedback(copied
      ? result.rail === "onchain" ? "주소와 금액이 포함된 BIP21 URI를 복사했습니다." : "BOLT11 인보이스를 복사했습니다."
      : "");
  }

  async function shareRequest() {
    if (!result || !resultUsable) {
      setFailure("현재 결제 요청을 공유할 수 없습니다. 새로 만드십시오.");
      return;
    }
    const candidate = result;
    const text = requestText(candidate);

    try {
      if (typeof navigator.share === "function") {
        let file: File | null = null;
        try {
          file = await canvasPngFile(candidate);
        } catch {
          file = null;
        }

        let canShareFile = false;
        if (file && typeof navigator.canShare === "function") {
          try {
            canShareFile = navigator.canShare({ files: [file] });
          } catch {
            canShareFile = false;
          }
        }
        if (file && canShareFile) {
          await navigator.share({
            title: resultShareTitle(candidate),
            text,
            files: [file],
          });
          setFeedback("결제 요청 문구와 QR 이미지를 공유 창으로 전달했습니다.");
        } else {
          await navigator.share({ title: resultShareTitle(candidate), text });
          setFeedback("결제 요청 문구를 공유했습니다. 이 기기는 QR 파일 동시 공유를 지원하지 않으므로 필요하면 QR PNG 저장을 사용하십시오.");
        }
        setFailure("");
        return;
      }

      const copied = await copyText(text);
      setFeedback(copied
        ? "공유 기능을 지원하지 않아 결제 요청 문구를 복사했습니다. QR은 QR PNG 저장으로 첨부하십시오."
        : "");
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
    if (!result || !resultUsable) {
      setFailure("현재 QR을 저장할 수 없습니다. 새로 만드십시오.");
      return;
    }
    try {
      const file = await canvasPngFile(result);
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
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
    setOnchainAddressInput("");
    setLightningAddressInput("");
    setInvoiceInput("");
    setBusy(false);
    resetMessages();
  }

  const statusDefault = rail === "onchain"
    ? "온체인 주소와 정확한 받을 금액을 합친 BIP21 요청과 QR을 만듭니다."
    : lightningMode === "address"
      ? "라이트닝 주소의 지갑 서비스가 이번 금액에 맞는 새 인보이스를 발급합니다."
      : "지갑에서 직접 만든 고정금액 BOLT11 인보이스를 붙여 넣어 금액과 QR을 확인합니다.";

  return (
    <section className={styles.panel} aria-labelledby="payment-request-title">
      <header className={styles.panelHeader}>
        <div>
          <p>거래 조건 합의 후 구매자가 사용</p>
          <h1 id="payment-request-title">BTC 받을 정보 만들기</h1>
        </div>
        <a className={styles.backLink} href="./">계산기로 돌아가기</a>
      </header>

      <fieldset className={styles.networkPicker}>
        <legend>BTC 전송 방식</legend>
        <label>
          <input
            type="radio"
            name="payment-request-rail"
            checked={rail === "onchain"}
            onChange={() => changeRail("onchain")}
          />
          <span><b>온체인</b><small>비트코인 주소</small></span>
        </label>
        <label>
          <input
            type="radio"
            name="payment-request-rail"
            checked={rail === "lightning"}
            onChange={() => changeRail("lightning")}
          />
          <span><b>라이트닝</b><small>주소 또는 인보이스</small></span>
        </label>
      </fieldset>

      <div className={styles.form}>
        <label className={styles.field} htmlFor="payment-request-sats">
          <span>받을 금액</span>
          <span className={styles.amountInput}>
            <input
              id="payment-request-sats"
              inputMode="numeric"
              value={satsInput}
              onChange={(event) => {
                clearResult();
                setSatsInput(digitsOnly(event.target.value));
                resetMessages();
              }}
              aria-invalid={satsInput !== "" && sats === null ? true : undefined}
            />
            <b>sats</b>
          </span>
        </label>

        {rail === "onchain" ? (
          <label className={styles.field} htmlFor="payment-request-onchain-address">
            <span>온체인 수취 주소</span>
            <input
              id="payment-request-onchain-address"
              className={styles.textInput}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={onchainAddressInput}
              placeholder="bc1… 또는 1… / 3…"
              onChange={(event) => {
                clearResult();
                setOnchainAddressInput(event.target.value.slice(0, 90));
                resetMessages();
              }}
            />
            <small>메인넷 주소 한 개만 입력하십시오. 시드 문구·개인키·xprv는 절대 입력하지 마십시오.</small>
          </label>
        ) : lightningMode === "address" ? (
          <label className={styles.field} htmlFor="payment-request-lightning-address">
            <span>라이트닝 주소</span>
            <input
              id="payment-request-lightning-address"
              className={styles.textInput}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={lightningAddressInput}
              placeholder="사용자명@도메인"
              onChange={(event) => changeLightningAddress(event.target.value)}
            />
            <small>주소의 지갑 서비스에 위 금액의 새 BOLT11 인보이스를 요청합니다.</small>
          </label>
        ) : (
          <label className={styles.field} htmlFor="payment-request-lightning-invoice">
            <span>고정금액 BOLT11 인보이스</span>
            <textarea
              id="payment-request-lightning-invoice"
              className={styles.textarea}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={invoiceInput}
              placeholder="lnbc…"
              onChange={(event) => {
                clearResult();
                setInvoiceInput(event.target.value.slice(0, MAX_BOLT11_LENGTH));
                resetMessages();
              }}
            />
            <small>지갑에서 위 금액으로 새로 만든 메인넷 인보이스를 입력하십시오.</small>
          </label>
        )}
      </div>

      {rail === "lightning" ? (
        <div className={styles.modeSwitch}>
          <span>{lightningMode === "address" ? "지갑에서 인보이스를 이미 만들었습니까?" : "라이트닝 주소로 자동 발급받겠습니까?"}</span>
          <button
            type="button"
            onClick={() => changeLightningMode(lightningMode === "address" ? "invoice" : "address")}
          >
            {lightningMode === "address" ? "인보이스 직접 입력" : "라이트닝 주소 사용"}
          </button>
        </div>
      ) : null}

      <div className={styles.primaryActions}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy}
          onClick={() => {
            if (rail === "onchain") buildOnchainRequest();
            else if (lightningMode === "address") void requestAddressInvoice();
            else buildDirectInvoice();
          }}
        >
          {busy
            ? "인보이스 요청 중"
            : rail === "onchain"
              ? "주소·금액 QR 만들기"
              : lightningMode === "address"
                ? "금액 고정 인보이스 만들기"
                : "인보이스 확인·QR 만들기"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={resetAll}>입력 지우기</button>
      </div>

      <p
        className={`${styles.status} ${failure ? styles.statusError : ""}`}
        role={failure ? "alert" : "status"}
        aria-live="polite"
      >
        {failure || feedback || statusDefault}
      </p>

      {result ? (
        <div className={`${styles.result} ${resultUsable ? "" : styles.expired}`}>
          <div className={styles.resultSummary}>
            <span>
              {resultUsable
                ? result.rail === "onchain" ? "온체인 요청 생성 완료" : "라이트닝 인보이스 생성 완료"
                : "인보이스 만료"}
            </span>
            <strong>{formatSats(result.sats)}</strong>
            <dl>
              {result.rail === "onchain" ? (
                <>
                  <div><dt>받을 주소</dt><dd>{result.address}</dd></div>
                  <div><dt>주소 형식</dt><dd>{result.scriptType}</dd></div>
                  <div><dt>BTC 금액</dt><dd>{result.btcAmount} BTC</dd></div>
                </>
              ) : (
                <>
                  {result.address ? <div><dt>라이트닝 주소</dt><dd>{result.address}</dd></div> : null}
                  <div><dt>인보이스 만료</dt><dd>{formatExpiry(result.expiresAt)}</dd></div>
                  <div><dt>남은 시간</dt><dd>{countdownLabel(remainingSeconds)}</dd></div>
                </>
              )}
            </dl>
          </div>

          <canvas
            ref={canvasRef}
            className={styles.qr}
            role="img"
            aria-label={`${result.sats} sats ${result.rail === "onchain" ? "온체인" : "라이트닝"} 결제 요청 QR`}
          />

          <details className={styles.invoiceDetails}>
            <summary>{result.rail === "onchain" ? "전체 주소·금액 URI 보기" : "전체 BOLT11 인보이스 보기"}</summary>
            <code dir="ltr">{resultPayload(result)}</code>
          </details>

          <div className={styles.exportActions}>
            <button type="button" disabled={!resultUsable} onClick={() => void shareRequest()}>결제 요청 공유 · QR 포함</button>
            <button type="button" disabled={!resultUsable} onClick={() => void copyPayload()}>
              {result.rail === "onchain" ? "주소·금액 URI 복사" : "인보이스 복사"}
            </button>
            <button type="button" disabled={!resultUsable} onClick={() => void downloadQr()}>QR PNG 저장</button>
          </div>

          <p className={styles.resultNote}>
            {result.rail === "onchain"
              ? "QR에는 온체인 주소와 정확한 BTC 금액이 함께 들어 있습니다. 실제 입금과 확인 수는 구매자 지갑에서 확인하십시오."
              : "QR에는 정확한 금액의 BOLT11 인보이스가 들어 있습니다. 실제 수취 완료는 구매자 지갑에서 확인하십시오."}
          </p>
        </div>
      ) : null}

      <p className={styles.privacyNote}>
        온체인 주소와 직접 입력한 인보이스는 이 브라우저에서만 처리합니다. 라이트닝 주소 방식은 인보이스 발급을 위해 주소와 금액을 이 프리뷰의 Cloudflare Worker 및 해당 지갑 서비스로 전달하지만 저장하지 않습니다.
      </p>
    </section>
  );
}
