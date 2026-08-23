"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { MAX_BOLT11_LENGTH, validateBolt11Invoice } from "../lib/bolt11-invoice.mjs";
import { createOnchainRequest, MAX_ONCHAIN_REQUEST_SATS } from "../lib/onchain-request.mjs";
import { createVerifiedTextQr } from "../lib/verified-qr.mjs";
import styles from "../lightning/lightning.module.css";

type Rail = "onchain" | "lightning";
type LightningMode = "address" | "invoice";
type Qr = { data: Uint8ClampedArray; height: number; payload: string; width: number };
type Result =
  | { kind: "onchain"; sats: number; address: string; btcAmount: string; payload: string; qr: Qr }
  | { kind: "lightning-address"; sats: number; address: string; payload: string; qr: Qr }
  | { kind: "lightning-invoice"; sats: number; invoice: string; expiresAt: number; payload: string; qr: Qr };

const MAX_SATS = Number(MAX_ONCHAIN_REQUEST_SATS);

function parseSats(value: string): number | null {
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount <= MAX_SATS ? amount : null;
}

function formatSats(value: number) {
  return `${value.toLocaleString("ko-KR")} sats`;
}

function formatExpiry(seconds: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1000));
}

function normalizeLightningAddress(value: string): string {
  const address = value.trim().toLowerCase();
  if (!address || address.length > 320 || /\s/u.test(address)) throw new Error("라이트닝 주소를 확인하십시오.");
  const parts = address.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !parts[1].includes(".")) {
    throw new Error("라이트닝 주소는 사용자명@도메인 형식이어야 합니다.");
  }
  if (!/^[a-z0-9._+-]+$/u.test(parts[0]) || !/^[a-z0-9.-]+$/u.test(parts[1])) {
    throw new Error("라이트닝 주소 형식을 확인하십시오.");
  }
  return address;
}

function friendlyError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function fileName(result: Result) {
  if (result.kind === "onchain") return "bitcoin-onchain-request.png";
  if (result.kind === "lightning-address") return "bitcoin-lightning-address.png";
  return "bitcoin-lightning-invoice.png";
}

function title(result: Result) {
  if (result.kind === "onchain") return "온체인 BTC 송금 요청";
  if (result.kind === "lightning-address") return "라이트닝 주소";
  return "라이트닝 인보이스";
}

function shareText(result: Result) {
  if (result.kind === "onchain") {
    return [
      "[BTC 송금 요청 · 온체인]",
      `받을 금액: ${formatSats(result.sats)} (${result.btcAmount} BTC)`,
      `받을 주소: ${result.address}`,
      `주소·금액 URI: ${result.payload}`,
    ].join("\n");
  }
  if (result.kind === "lightning-address") {
    return [
      "[BTC 송금 요청 · 라이트닝 주소]",
      `받을 금액: ${formatSats(result.sats)}`,
      `라이트닝 주소: ${result.address}`,
      "QR에는 라이트닝 주소만 들어 있습니다. 금액은 보내는 지갑에서 확인하여 입력하십시오.",
    ].join("\n");
  }
  return [
    "[BTC 송금 요청 · 라이트닝 인보이스]",
    `받을 금액: ${formatSats(result.sats)}`,
    `인보이스 만료: ${formatExpiry(result.expiresAt)}`,
    "BOLT11:",
    result.invoice,
  ].join("\n");
}

function legacyCopy(value: string) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 구형 복사 방식으로 다시 시도합니다.
  }
  return legacyCopy(value);
}

export function BtcReceiveRequest() {
  const [rail, setRail] = useState<Rail>("onchain");
  const [mode, setMode] = useState<LightningMode>("address");
  const [satsInput, setSatsInput] = useState("100000");
  const [onchainAddress, setOnchainAddress] = useState("");
  const [lightningAddress, setLightningAddress] = useState("");
  const [invoice, setInvoice] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [feedback, setFeedback] = useState("");
  const [failure, setFailure] = useState("");
  const [now, setNow] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const resultRef = useRef<Result | null>(null);

  const sats = useMemo(() => parseSats(satsInput), [satsInput]);
  const remaining = result?.kind === "lightning-invoice" && now
    ? Math.max(0, result.expiresAt - Math.floor(now / 1000))
    : null;
  const usable = Boolean(result && (remaining === null || remaining > 0));

  const clearResult = useCallback(() => {
    resultRef.current?.qr.data.fill(0);
    resultRef.current = null;
    setResult(null);
    setNow(0);
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
    }
  }, []);

  function resetMessage() {
    setFeedback("");
    setFailure("");
  }

  useEffect(() => {
    const sync = () => {
      const active = window.location.hash === "#lightning-preview" || window.location.hash === "#payment-request-preview";
      document.documentElement.classList.toggle("payment-request-preview-active", active);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      document.documentElement.classList.remove("payment-request-preview-active");
    };
  }, []);

  useEffect(() => {
    if (result?.kind !== "lightning-invoice") return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [result]);

  useLayoutEffect(() => {
    if (!result || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = result.qr.width;
    canvas.height = result.qr.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const pixels = context.createImageData(result.qr.width, result.qr.height);
    pixels.data.set(result.qr.data);
    context.imageSmoothingEnabled = false;
    context.putImageData(pixels, 0, 0);
    pixels.data.fill(0);
  }, [result]);

  function setNextResult(next: Result, message: string) {
    clearResult();
    resultRef.current = next;
    setResult(next);
    setFeedback(message);
    setFailure("");
  }

  function buildOnchain() {
    if (sats === null) return setFailure("받을 sats를 올바르게 입력하십시오.");
    try {
      const request = createOnchainRequest(onchainAddress.trim(), BigInt(sats));
      const qr = createVerifiedTextQr(request.uri, { maximumLength: 220, maximumPixelSize: 580, level: "M" });
      setNextResult({ kind: "onchain", sats, address: request.address, btcAmount: request.btcAmount, payload: request.uri, qr }, "주소와 금액이 포함된 온체인 QR을 만들었습니다.");
      setOnchainAddress(request.address);
    } catch (error) {
      clearResult();
      setFeedback("");
      setFailure(friendlyError(error, "온체인 주소를 확인하십시오."));
    }
  }

  function buildLightningAddress() {
    if (sats === null) return setFailure("받을 sats를 올바르게 입력하십시오.");
    try {
      const address = normalizeLightningAddress(lightningAddress);
      const qr = createVerifiedTextQr(address, { maximumLength: 320, maximumPixelSize: 580, level: "M" });
      setNextResult({ kind: "lightning-address", sats, address, payload: address, qr }, "라이트닝 주소와 주소 QR을 만들었습니다. QR에는 금액이 포함되지 않습니다.");
      setLightningAddress(address);
    } catch (error) {
      clearResult();
      setFeedback("");
      setFailure(friendlyError(error, "라이트닝 주소를 확인하십시오."));
    }
  }

  function buildInvoice() {
    if (sats === null) return setFailure("받을 sats를 올바르게 입력하십시오.");
    if (!invoice.trim()) return setFailure("BOLT11 인보이스를 붙여 넣으십시오.");
    try {
      const checked = validateBolt11Invoice(invoice, { expectedSats: BigInt(sats), minimumRemainingSeconds: 60 });
      const qr = createVerifiedTextQr(checked.canonicalInvoice.toUpperCase(), { maximumLength: MAX_BOLT11_LENGTH, maximumPixelSize: 580, level: "M" });
      setNextResult({ kind: "lightning-invoice", sats, invoice: checked.canonicalInvoice, expiresAt: checked.expiresAt, payload: checked.canonicalInvoice, qr }, "인보이스의 메인넷·금액·만료시간을 확인했습니다.");
      setInvoice(checked.canonicalInvoice);
      setNow(Date.now());
    } catch (error) {
      clearResult();
      setFeedback("");
      setFailure(friendlyError(error, "인보이스가 받을 금액과 일치하는지 확인하십시오."));
    }
  }

  async function pngFile(candidate: Result) {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("QR 화면이 없습니다.");
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("QR PNG 생성 실패")), "image/png"));
    return new File([blob], fileName(candidate), { type: "image/png", lastModified: Date.now() });
  }

  async function share() {
    if (!result || !usable) return setFailure("현재 정보를 공유할 수 없습니다. 다시 만드십시오.");
    const text = shareText(result);
    try {
      if (typeof navigator.share === "function") {
        let file: File | null = null;
        try { file = await pngFile(result); } catch { file = null; }
        let canShareFile = false;
        if (file && typeof navigator.canShare === "function") {
          try { canShareFile = navigator.canShare({ files: [file] }); } catch { canShareFile = false; }
        }
        if (file && canShareFile) await navigator.share({ title: title(result), text, files: [file] });
        else await navigator.share({ title: title(result), text });
        setFeedback(file && canShareFile ? "문구와 QR 이미지를 함께 공유했습니다." : "문구를 공유했습니다. QR 이미지는 별도로 저장할 수 있습니다.");
        setFailure("");
        return;
      }
      const copied = await copyText(text);
      setFeedback(copied ? "공유 문구를 복사했습니다. QR 이미지는 별도로 저장하십시오." : "");
      setFailure(copied ? "" : "공유 문구를 복사하지 못했습니다.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setFeedback("공유를 취소했습니다.");
        setFailure("");
      } else {
        setFeedback("");
        setFailure("공유하지 못했습니다.");
      }
    }
  }

  async function saveQr() {
    if (!result || !usable) return setFailure("현재 QR을 저장할 수 없습니다.");
    try {
      const file = await pngFile(result);
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFeedback("QR PNG 저장을 시작했습니다.");
      setFailure("");
    } catch {
      setFailure("QR PNG를 만들지 못했습니다.");
    }
  }

  async function copyPayload() {
    if (!result || !usable) return setFailure("현재 정보를 복사할 수 없습니다.");
    const copied = await copyText(result.payload);
    setFeedback(copied ? (result.kind === "lightning-invoice" ? "BOLT11 인보이스를 복사했습니다." : "주소 정보를 복사했습니다.") : "");
    setFailure(copied ? "" : "복사하지 못했습니다.");
  }

  const status = failure || feedback || (
    rail === "onchain"
      ? "온체인 주소와 받을 sats를 입력하면 금액이 포함된 BIP21 QR을 만듭니다."
      : mode === "address"
        ? "라이트닝 주소를 그대로 공유하고 주소 QR을 만듭니다. QR에는 금액이 포함되지 않습니다."
        : "지갑에서 만든 BOLT11 인보이스가 받을 sats와 정확히 같은지 확인합니다."
  );

  return (
    <section className={styles.panel} aria-labelledby="payment-request-title">
      <header className={styles.panelHeader}>
        <div><p>거래 조건 합의 후 구매자가 사용</p><h1 id="payment-request-title">BTC 받을 정보 만들기</h1></div>
        <a className={styles.backLink} href="./">계산기로 돌아가기</a>
      </header>

      <fieldset className={styles.networkPicker}>
        <legend>BTC 전송 방식</legend>
        <label><input type="radio" checked={rail === "onchain"} onChange={() => { clearResult(); setRail("onchain"); resetMessage(); }} /><span><b>온체인</b><small>비트코인 주소</small></span></label>
        <label><input type="radio" checked={rail === "lightning"} onChange={() => { clearResult(); setRail("lightning"); setMode("address"); resetMessage(); }} /><span><b>라이트닝</b><small>주소 또는 인보이스</small></span></label>
      </fieldset>

      <div className={styles.form}>
        <label className={styles.field}><span>받을 금액</span><span className={styles.amountInput}><input inputMode="numeric" value={satsInput} onChange={event => { clearResult(); setSatsInput(event.target.value.replace(/\D/gu, "").slice(0, 16)); resetMessage(); }} /><b>sats</b></span></label>

        {rail === "onchain" ? (
          <label className={styles.field}><span>온체인 수취 주소</span><input className={styles.textInput} value={onchainAddress} onChange={event => { clearResult(); setOnchainAddress(event.target.value); resetMessage(); }} placeholder="bc1..." /></label>
        ) : mode === "address" ? (
          <label className={styles.field}><span>라이트닝 주소</span><input className={styles.textInput} value={lightningAddress} onChange={event => { clearResult(); setLightningAddress(event.target.value); resetMessage(); }} placeholder="사용자명@도메인" /></label>
        ) : (
          <label className={styles.field}><span>BOLT11 인보이스</span><textarea className={styles.textarea} value={invoice} onChange={event => { clearResult(); setInvoice(event.target.value.slice(0, MAX_BOLT11_LENGTH)); resetMessage(); }} placeholder="lnbc..." /></label>
        )}
      </div>

      {rail === "lightning" ? (
        <div className={styles.modeSwitch}>
          <span>{mode === "address" ? "기본은 라이트닝 주소 공유입니다." : "인보이스에는 정확한 받을 금액이 들어 있어야 합니다."}</span>
          <button type="button" onClick={() => { clearResult(); setMode(mode === "address" ? "invoice" : "address"); resetMessage(); }}>{mode === "address" ? "인보이스 직접 입력" : "라이트닝 주소 사용"}</button>
        </div>
      ) : null}

      <div className={styles.primaryActions}>
        <button className={styles.primaryButton} type="button" onClick={rail === "onchain" ? buildOnchain : mode === "address" ? buildLightningAddress : buildInvoice}>{rail === "onchain" ? "온체인 요청 만들기" : mode === "address" ? "주소 QR 만들기" : "인보이스 확인하기"}</button>
        <button className={styles.secondaryButton} type="button" onClick={() => { clearResult(); setOnchainAddress(""); setLightningAddress(""); setInvoice(""); resetMessage(); }}>초기화</button>
      </div>

      <p className={`${styles.status} ${failure ? styles.statusError : ""}`} role={failure ? "alert" : "status"}>{status}</p>

      {result ? (
        <section className={`${styles.result} ${remaining === 0 ? styles.expired : ""}`}>
          <div className={styles.resultSummary}>
            <span>{result.kind === "onchain" ? "온체인" : result.kind === "lightning-address" ? "라이트닝 주소" : "라이트닝 인보이스"}</span>
            <strong>{formatSats(result.sats)}</strong>
            <dl>
              {result.kind === "onchain" ? <><div><dt>받을 주소</dt><dd>{result.address}</dd></div><div><dt>BIP21</dt><dd>{result.payload}</dd></div></> : null}
              {result.kind === "lightning-address" ? <><div><dt>라이트닝 주소</dt><dd>{result.address}</dd></div><div><dt>QR 내용</dt><dd>주소만 포함</dd></div></> : null}
              {result.kind === "lightning-invoice" ? <><div><dt>만료</dt><dd>{formatExpiry(result.expiresAt)}</dd></div><div><dt>남은 시간</dt><dd>{remaining === null ? "—" : remaining > 0 ? `${Math.floor(remaining / 60)}분 ${remaining % 60}초` : "만료됨"}</dd></div><div><dt>BOLT11</dt><dd>{result.invoice}</dd></div></> : null}
            </dl>
          </div>
          <canvas ref={canvasRef} className={styles.qr} aria-label="BTC 수취 정보 QR" />
        </section>
      ) : null}

      {result ? (
        <div className={styles.exportActions}>
          <button type="button" onClick={() => void share()} disabled={!usable}>문구 + QR 공유</button>
          <button type="button" onClick={() => void copyPayload()} disabled={!usable}>{result.kind === "lightning-invoice" ? "BOLT11 복사" : "주소 복사"}</button>
          <button type="button" onClick={() => void saveQr()} disabled={!usable}>QR PNG 저장</button>
        </div>
      ) : null}
    </section>
  );
}
