"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAX_BOLT11_LENGTH, validateBolt11Invoice } from "../lib/bolt11-invoice.mjs";
import { createOnchainRequest } from "../lib/onchain-request.mjs";
import { createVerifiedTextQr, verifyQrRasterPayload } from "../lib/verified-qr.mjs";
import styles from "./trade-receive-info.module.css";

export type ReceiveRail = "onchain" | "lightning";
type Rail = ReceiveRail;
type LightningMode = "address" | "invoice";
type PasteTarget = "onchain" | "lightning" | "invoice";
type QrArtifact = { data: Uint8ClampedArray; height: number; width: number; payload: string };
export type VerifiedReceiveInfo = Readonly<{
  kind: "onchain" | "lightning-generated" | "lightning-invoice";
  rail: Rail;
  amountSats: number;
  payload: string;
  copyTarget: string;
  address?: string;
  expiresAt?: number;
}>;
type Result = VerifiedReceiveInfo & {
  conditionKey: string;
  ownerRole: "buyer" | "seller";
  shareText: string;
  qr: QrArtifact;
};
type LightningPayResponse = {
  ok?: boolean;
  amountSats?: number;
  invoice?: string;
  message?: string;
  normalizedSource?: string;
  sourceType?: "address" | "lnurl" | "url";
  address?: string;
};

const MIN_SHARE_REMAINING_SECONDS = 120;
const QR_LOGO_SRC = "/creator-logo.jpg";
const QR_LOGO_RATIO = 0.12;
let qrLogoPromise: Promise<HTMLImageElement> | null = null;

function loadQrLogo(): Promise<HTMLImageElement> {
  if (qrLogoPromise) return qrLogoPromise;
  qrLogoPromise = new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("QR 로고 원본을 불러오지 못했습니다."));
    image.src = QR_LOGO_SRC;
  });
  return qrLogoPromise;
}

async function drawVerifiedQrLogo(canvas: HTMLCanvasElement, payload: string) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("QR 캔버스를 확인하지 못했습니다.");
  const logo = await loadQrLogo();
  const size = Math.max(32, Math.round(Math.min(canvas.width, canvas.height) * QR_LOGO_RATIO));
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const x = Math.round(centerX - size / 2);
  const y = Math.round(centerY - size / 2);
  const radius = size / 2;

  context.save();
  context.fillStyle = "#fff";
  context.beginPath();
  context.arc(centerX, centerY, radius * 1.08, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.clip();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(logo, x, y, size, size);
  context.restore();

  const branded = context.getImageData(0, 0, canvas.width, canvas.height);
  verifyQrRasterPayload(branded, payload);
  branded.data.fill(0);
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
  }).format(new Date(seconds * 1_000));
}

function formatRemaining(seconds: number) {
  if (seconds <= 0) return "만료됨";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")} 남음`;
}

function invoiceLike(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("lnbc") || normalized.startsWith("lightning:lnbc");
}

function lightningAddressLike(value: string) {
  return /^[^\s@]+@[^\s@]+$/u.test(value.trim());
}

function parseBip21AmountSats(value: string) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/u.exec(value);
  if (!match) throw new Error("BIP21 금액은 소수점 아래 8자리 이내의 BTC 수량이어야 합니다.");
  return BigInt(match[1]) * BigInt(100_000_000) + BigInt((match[2] ?? "").padEnd(8, "0"));
}

function onchainAddressFromInput(value: string, amountSats: number) {
  const trimmed = value.trim();
  if (!/^bitcoin:/iu.test(trimmed)) return trimmed;
  if (/^bitcoin:\/\//iu.test(trimmed) || trimmed.includes("#")) {
    throw new Error("bitcoin: 뒤에 메인넷 주소 한 개가 있는 BIP21만 사용할 수 있습니다.");
  }

  const body = trimmed.slice("bitcoin:".length);
  const separator = body.indexOf("?");
  const address = separator < 0 ? body : body.slice(0, separator);
  const query = separator < 0 ? "" : body.slice(separator + 1);
  if (!address || address.includes("%")) {
    throw new Error("BIP21의 비트코인 주소 형식을 확인하지 못했습니다.");
  }

  const parameters = new URLSearchParams(query);
  if ([...parameters.keys()].some((key) => key.toLowerCase().startsWith("req-"))) {
    throw new Error("지원하지 않는 필수 항목이 있는 BIP21은 사용할 수 없습니다.");
  }
  const amounts = parameters.getAll("amount");
  if (amounts.length > 1) throw new Error("BIP21에는 금액을 한 번만 넣을 수 있습니다.");

  const request = createOnchainRequest(address, BigInt(amountSats));
  if (amounts.length === 1 && parseBip21AmountSats(amounts[0]) !== BigInt(amountSats)) {
    throw new Error("BIP21 금액이 현재 거래에서 받을 금액과 정확히 일치하지 않습니다.");
  }
  return request.address;
}

async function copyPlainText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.inset = "-9999px auto auto -9999px";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("copy failed");
}

async function qrFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("QR 생성 실패")), "image/png");
  });
  return new File([blob], name, { type: "image/png", lastModified: Date.now() });
}

async function readLightningPayResponse(response: Response): Promise<LightningPayResponse> {
  const text = await response.text();
  if (!text) throw new Error(`라이트닝 결제 요청 서버가 빈 응답을 반환했습니다. (HTTP ${response.status})`);
  try {
    return JSON.parse(text) as LightningPayResponse;
  } catch {
    const contentType = response.headers.get("content-type") ?? "알 수 없음";
    const preview = text.replace(/\s+/gu, " ").trim().slice(0, 120);
    throw new Error(`라이트닝 API가 JSON이 아닌 응답을 반환했습니다. (HTTP ${response.status}, ${contentType})${preview ? ` · ${preview}` : ""}`);
  }
}

export type TradeReceiveInfoProps = {
  expectedSats: number | null;
  conditionKey: string;
  ownerRole: "buyer" | "seller";
  onResultChange: (info: VerifiedReceiveInfo | null) => void;
};

export function TradeReceiveInfoPortal({ expectedSats, conditionKey, ownerRole, onResultChange }: TradeReceiveInfoProps) {
  const [rail, setRail] = useState<Rail>("onchain");
  const [lightningMode, setLightningMode] = useState<LightningMode>("address");
  const [onchain, setOnchain] = useState("");
  const [lightningSource, setLightningSource] = useState("");
  const [invoice, setInvoice] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [qrReady, setQrReady] = useState(false);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const generationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const onResultChangeRef = useRef(onResultChange);

  const remainingSeconds = useMemo(() => {
    if (!result?.expiresAt) return null;
    return Math.max(0, result.expiresAt - nowSeconds);
  }, [nowSeconds, result?.expiresAt]);

  const resultStale = Boolean(result && (
    expectedSats !== result.amountSats
    || conditionKey !== result.conditionKey
    || ownerRole !== result.ownerRole
  ));
  const resultExpiring = remainingSeconds !== null && remainingSeconds < MIN_SHARE_REMAINING_SECONDS;
  const resultShareable = Boolean(result && qrReady && !resultStale && !resultExpiring);

  useEffect(() => {
    generationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
  }, [conditionKey, expectedSats, ownerRole]);

  useLayoutEffect(() => {
    onResultChangeRef.current = onResultChange;
  }, [onResultChange]);

  const verifiedInfo = useMemo<VerifiedReceiveInfo | null>(() => {
    if (!result || !resultShareable) return null;
    return Object.freeze({
      kind: result.kind,
      rail: result.rail,
      amountSats: result.amountSats,
      payload: result.payload,
      copyTarget: result.copyTarget,
      address: result.address,
      expiresAt: result.expiresAt,
    });
  }, [result, resultShareable]);

  useLayoutEffect(() => {
    onResultChangeRef.current(verifiedInfo);
  }, [verifiedInfo]);

  useEffect(() => () => {
    generationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    onResultChangeRef.current(null);
  }, []);

  useEffect(() => {
    if (!result?.expiresAt) return;
    const tick = () => setNowSeconds(Math.floor(Date.now() / 1_000));
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [result?.expiresAt]);

  useLayoutEffect(() => {
    if (!result || !canvasRef.current) return;
    let cancelled = false;
    setQrReady(false);
    const canvas = canvasRef.current;
    canvas.width = result.qr.width;
    canvas.height = result.qr.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(result.qr.width, result.qr.height);
    image.data.set(result.qr.data);
    context.imageSmoothingEnabled = false;
    context.putImageData(image, 0, 0);
    image.data.fill(0);

    void drawVerifiedQrLogo(canvas, result.qr.payload)
      .then(() => {
        if (cancelled) return;
        setError("");
        setQrReady(true);
      })
      .catch((reason) => {
        if (cancelled) return;
        setQrReady(false);
        setError(reason instanceof Error ? reason.message : "로고가 포함된 QR을 확인하지 못했습니다.");
      });

    return () => {
      cancelled = true;
    };
  }, [result]);

  function clear() {
    generationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    onResultChangeRef.current(null);
    result?.qr.data.fill(0);
    setResult(null);
    setQrReady(false);
    setError("");
    setFeedback("");
    setBusy(false);
  }

  function changeLightningSource(value: string) {
    if (invoiceLike(value)) {
      clear();
      setInvoice(value.slice(0, MAX_BOLT11_LENGTH));
      setLightningSource("");
      setLightningMode("invoice");
      setFeedback("BOLT11 인보이스로 인식하여 직접 입력 방식으로 전환했습니다.");
      return;
    }
    clear();
    setLightningSource(value.slice(0, 2_048));
  }

  async function pasteFromClipboard(target: PasteTarget) {
    if (busy) return;
    if (!navigator.clipboard?.readText) {
      setError("이 브라우저는 붙여넣기 버튼을 지원하지 않습니다. 입력칸을 길게 눌러 붙여넣으십시오.");
      return;
    }
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        setError("클립보드에 붙여넣을 텍스트가 없습니다.");
        return;
      }
      if (target === "onchain") {
        clear();
        setOnchain(text.slice(0, 220));
        setFeedback("클립보드의 온체인 주소를 붙여넣었습니다.");
        return;
      }
      if (target === "lightning") {
        changeLightningSource(text);
        if (!invoiceLike(text)) setFeedback("클립보드의 라이트닝 수취정보를 붙여넣었습니다.");
        return;
      }
      clear();
      setInvoice(text.slice(0, MAX_BOLT11_LENGTH));
      setFeedback("클립보드의 BOLT11 인보이스를 붙여넣었습니다.");
    } catch {
      setError("클립보드를 읽지 못했습니다. 입력칸을 길게 눌러 붙여넣으십시오.");
    }
  }

  function makeLightningInvoiceResult(rawInvoice: string, amountSats: number, generated: boolean): Result {
    const checked = validateBolt11Invoice(rawInvoice, {
      expectedSats: BigInt(amountSats),
      minimumRemainingSeconds: MIN_SHARE_REMAINING_SECONDS,
    });
    const qr = createVerifiedTextQr(checked.canonicalInvoice.toUpperCase(), {
      maximumLength: MAX_BOLT11_LENGTH,
      maximumPixelSize: 520,
      level: "M",
    });
    return {
      kind: generated ? "lightning-generated" : "lightning-invoice",
      rail: "lightning",
      amountSats,
      conditionKey,
      ownerRole,
      payload: checked.canonicalInvoice,
      copyTarget: checked.canonicalInvoice,
      expiresAt: checked.expiresAt,
      qr,
      shareText: [
        "[BTC 수취정보 · 라이트닝 인보이스]",
        `받을 금액: ${formatSats(amountSats)}`,
        `인보이스 만료: ${formatExpiry(checked.expiresAt)}`,
        "BOLT11:",
        checked.canonicalInvoice,
      ].join("\n"),
    };
  }

  async function build() {
    if (busy) return;
    clear();
    if (!expectedSats) {
      setError("거래 금액을 먼저 계산하십시오.");
      return;
    }

    if (rail === "onchain") {
      try {
        const address = onchainAddressFromInput(onchain, expectedSats);
        const request = createOnchainRequest(address, BigInt(expectedSats));
        const qr = createVerifiedTextQr(request.uri, { maximumLength: 220, maximumPixelSize: 520, level: "M" });
        setResult({
          kind: "onchain",
          rail: "onchain",
          amountSats: expectedSats,
          conditionKey,
          ownerRole,
          payload: request.uri,
          copyTarget: request.address,
          address: request.address,
          qr,
          shareText: [
            "[BTC 수취정보 · 온체인]",
            `받을 금액: ${formatSats(expectedSats)}`,
            `주소: ${request.address}`,
            `BIP21: ${request.uri}`,
          ].join("\n"),
        });
        setFeedback("주소와 거래 금액을 확인하여 BIP21 QR을 만들었습니다.");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "온체인 수취정보를 확인하지 못했습니다.");
      }
      return;
    }

    if (lightningMode === "invoice") {
      if (!invoice.trim()) {
        setError("BOLT11 인보이스를 입력하십시오.");
        return;
      }
      try {
        setResult(makeLightningInvoiceResult(invoice, expectedSats, false));
        setFeedback("인보이스의 메인넷·금액·서명·만료시간을 확인했습니다.");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "라이트닝 인보이스를 확인하지 못했습니다.");
      }
      return;
    }

    const source = lightningSource.trim();
    if (!source) {
      setError("라이트닝 주소 또는 LNURL-pay를 입력하십시오.");
      return;
    }

    const isAddress = lightningAddressLike(source);
    setBusy(true);
    setFeedback("결제에 사용할 새 인보이스를 요청하고 있습니다.");
    const generation = generationRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);

    try {
      const endpoint = isAddress
        ? "/api/market?receive=lightning-address"
        : "/api/market?receive=lightning-pay";
      const body = isAddress
        ? { address: source, amountSats: expectedSats }
        : { source, amountSats: expectedSats };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      const data = await readLightningPayResponse(response);
      if (!response.ok || !data.ok || typeof data.invoice !== "string" || data.amountSats !== expectedSats) {
        throw new Error(data.message || `라이트닝 수취정보에서 인보이스를 만들지 못했습니다. (HTTP ${response.status})`);
      }
      if (generationRef.current !== generation) return;
      const next = makeLightningInvoiceResult(data.invoice, expectedSats, true);
      if (generationRef.current !== generation) {
        next.qr.data.fill(0);
        return;
      }
      setResult(next);
      const normalized = isAddress ? data.address : data.normalizedSource;
      if (typeof normalized === "string") setLightningSource(normalized);
      setError("");
      setFeedback("지금 결제할 수 있는 새 고정금액 인보이스를 만들었습니다.");
    } catch (reason) {
      if (generationRef.current !== generation) return;
      if (controller.signal.aborted) {
        setError("라이트닝 지갑 서비스의 응답 시간이 초과되었습니다. 다시 시도하거나 인보이스를 직접 입력하십시오.");
      } else {
        setError(reason instanceof Error ? reason.message : "라이트닝 결제 요청을 만들지 못했습니다.");
      }
      setFeedback("");
    } finally {
      window.clearTimeout(timeout);
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      setBusy(false);
    }
  }

  async function share() {
    if (!result || !canvasRef.current) return;
    if (resultStale) {
      setError("거래 조건이 바뀌었습니다. 현재 금액으로 수취정보를 다시 만드십시오.");
      return;
    }
    if (!qrReady) {
      setError("로고가 포함된 QR을 확인하는 중입니다. 잠시 후 다시 시도하십시오.");
      return;
    }
    if (remainingSeconds !== null && remainingSeconds < MIN_SHARE_REMAINING_SECONDS) {
      setError("인보이스 만료가 임박했습니다. 새 인보이스를 만든 뒤 공유하십시오.");
      return;
    }
    try {
      if (result.kind === "onchain") {
        const checked = createOnchainRequest(result.copyTarget, BigInt(result.amountSats));
        if (checked.uri !== result.payload) throw new Error("온체인 수취정보가 생성 당시 값과 다릅니다.");
      } else {
        const checked = validateBolt11Invoice(result.payload, {
          expectedSats: BigInt(result.amountSats),
          minimumRemainingSeconds: MIN_SHARE_REMAINING_SECONDS,
        });
        if (checked.canonicalInvoice !== result.payload || checked.expiresAt !== result.expiresAt) {
          throw new Error("라이트닝 인보이스가 생성 당시 값과 다릅니다.");
        }
      }
      const file = await qrFile(
        canvasRef.current,
        result.kind === "onchain" ? "onchain-qr.png" : "lightning-invoice-qr.png",
      );
      if (navigator.share) {
        const canFile = typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
        if (canFile) {
          await navigator.share({ title: "BTC 수취정보", text: result.shareText, files: [file] });
          setFeedback("수취정보 문구와 QR 이미지를 공유했습니다.");
          return;
        }
        await navigator.share({ title: "BTC 수취정보", text: result.shareText });
        setFeedback("수취정보 문구를 공유했습니다. 이 기기는 QR 파일 동시 공유를 지원하지 않습니다.");
        return;
      }
      await copyPlainText(result.shareText);
      setFeedback("수취정보 문구를 복사했습니다.");
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "수취정보를 공유하지 못했습니다.");
    }
  }

  async function copyTarget() {
    if (!result || resultStale) {
      setError("거래 조건이 바뀌었습니다. 현재 금액으로 수취정보를 다시 만드십시오.");
      return;
    }
    if (resultExpiring) {
      setError("인보이스 만료가 임박했습니다. 새 인보이스를 만든 뒤 복사하십시오.");
      return;
    }
    try {
      if (result.kind === "onchain") {
        createOnchainRequest(result.copyTarget, BigInt(result.amountSats));
      } else {
        validateBolt11Invoice(result.copyTarget, {
          expectedSats: BigInt(result.amountSats),
          minimumRemainingSeconds: MIN_SHARE_REMAINING_SECONDS,
        });
      }
      await copyPlainText(result.copyTarget);
      setError("");
      setFeedback(result.kind === "onchain" ? "온체인 주소만 복사했습니다." : "BOLT11 인보이스만 복사했습니다.");
    } catch (reason) {
      setError(reason instanceof Error && reason.message !== "copy failed"
        ? reason.message
        : "복사하지 못했습니다. 수취정보를 길게 눌러 복사하십시오.");
    }
  }

  const buildLabel = rail === "onchain"
    ? "QR 만들기"
    : lightningMode === "address"
      ? busy ? "인보이스 요청 중" : result?.kind === "lightning-generated" ? "새 인보이스 만들기" : "결제 직전 인보이스 만들기"
      : "인보이스 확인 및 QR 만들기";

  const inputRowStyle = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "6px", alignItems: "stretch" } as const;

  return (
    <section className={styles.section} aria-labelledby="receive-info-title">
      <div className={styles.header}>
        <h3 id="receive-info-title">{ownerRole === "buyer" ? "내 BTC 받을 정보" : "구매자가 제공한 BTC 받을 정보"} <span>(선택 사항)</span></h3>
      </div>
      <p className={styles.intro}>{ownerRole === "buyer"
        ? "내가 받을 주소나 인보이스를 거래 기록 카드에 함께 넣을 수 있습니다."
        : "구매자가 확인해 준 주소나 인보이스를 거래 기록 카드에 함께 넣을 수 있습니다."}</p>
      <p className={styles.amountNote}>현재 거래에서 받을 금액 <b>{expectedSats ? formatSats(expectedSats) : "계산 전"}</b></p>

      <fieldset className={styles.railPicker} disabled={busy}>
        <legend>BTC 전송 방식</legend>
        <label>
          <input aria-label="온체인" type="radio" name="embedded-receive-rail" checked={rail === "onchain"} onChange={() => { clear(); setRail("onchain"); }} />
          <span><strong>온체인</strong><small>비트코인 주소</small></span>
        </label>
        <label>
          <input aria-label="라이트닝" type="radio" name="embedded-receive-rail" checked={rail === "lightning"} onChange={() => { clear(); setRail("lightning"); setLightningMode("address"); }} />
          <span><strong>라이트닝</strong><small>주소·LNURL 또는 인보이스</small></span>
        </label>
      </fieldset>

      {rail === "onchain" ? (
        <div className={styles.field}>
          <label htmlFor="receive-onchain">온체인 수취 주소</label>
          <div style={inputRowStyle}>
            <input id="receive-onchain" className={styles.input} value={onchain} disabled={busy} maxLength={220} onChange={(event) => { clear(); setOnchain(event.target.value); }} placeholder="bc1q... · bc1p... · bitcoin:..." />
            <button className={styles.modeButton} type="button" disabled={busy} onClick={() => void pasteFromClipboard("onchain")}>붙여넣기</button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.modeRow}>
            <p>{lightningMode === "address"
              ? "주소는 그대로 두고, 실제 결제·공유 직전에 새 고정금액 인보이스를 만듭니다."
              : "지갑에서 직접 만든 인보이스를 거래 금액과 대조합니다."}</p>
            <button className={styles.modeButton} type="button" disabled={busy} onClick={() => { clear(); setLightningMode(lightningMode === "address" ? "invoice" : "address"); }}>
              {lightningMode === "address" ? "인보이스 직접 입력" : "라이트닝 주소 사용"}
            </button>
          </div>
          {lightningMode === "address" ? (
            <div className={styles.field}>
              <label htmlFor="receive-lightning">라이트닝 주소 / LNURL-pay</label>
              <div style={inputRowStyle}>
                <input id="receive-lightning" className={styles.input} value={lightningSource} disabled={busy} onChange={(event) => changeLightningSource(event.target.value)} placeholder="username@example.com 또는 LNURL1..." />
                <button className={styles.modeButton} type="button" disabled={busy} onClick={() => void pasteFromClipboard("lightning")}>붙여넣기</button>
              </div>
              <small>Lightning Address는 결제 직전에 새 BOLT11을 요청합니다. 추가 결제자 정보를 필수로 요구하는 주소는 자동 생성을 중단하고 직접 인보이스 입력을 안내합니다.</small>
            </div>
          ) : (
            <div className={styles.field}>
              <label htmlFor="receive-invoice">BOLT11 인보이스</label>
              <div style={inputRowStyle}>
                <textarea id="receive-invoice" className={styles.textarea} value={invoice} disabled={busy} onChange={(event) => { clear(); setInvoice(event.target.value); }} placeholder="lnbc... 또는 lightning:lnbc..." />
                <button className={styles.modeButton} type="button" disabled={busy} onClick={() => void pasteFromClipboard("invoice")}>붙여넣기</button>
              </div>
              <small>메인넷·서명·만료시간과 현재 거래의 받을 sats가 정확히 같은지 확인합니다.</small>
            </div>
          )}
        </>
      )}

      <div className={styles.actions}>
        <button className={styles.primary} type="button" disabled={busy} onClick={() => void build()}>{buildLabel}</button>
        <button className={styles.secondary} type="button" disabled={busy} onClick={() => { clear(); setOnchain(""); setLightningSource(""); setInvoice(""); }}>초기화</button>
      </div>

      {error ? <p className={`${styles.status} ${styles.error}`} role="alert">{error}</p> : feedback ? <p className={styles.status} role="status">{feedback}</p> : null}

      {result ? (
        <div className={styles.result}>
          <div className={styles.resultInfo}>
            <span className={styles.resultBadge}>{result.kind === "onchain" ? "온체인" : "라이트닝 인보이스"}</span>
            <strong className={styles.resultAmount}>{formatSats(result.amountSats)}</strong>
            <p className={styles.lockNote}>이 QR을 사용하는 동안 거래 금액을 고정합니다. 초기화하면 최신 시세를 다시 반영합니다.</p>
            <dl>
              <div><dt>공유 내용</dt><dd>{result.kind === "onchain" ? "BIP21 + QR" : "BOLT11 + QR"}</dd></div>
              {result.expiresAt ? <div><dt>만료</dt><dd>{formatExpiry(result.expiresAt)} · {remainingSeconds === null ? "—" : formatRemaining(remainingSeconds)}</dd></div> : null}
            </dl>
            <div className={styles.resultTarget}>
              <span>{result.kind === "onchain" ? "온체인 주소" : "BOLT11 인보이스"}</span>
              <code>{result.copyTarget}</code>
            </div>
            {resultStale ? <p className={styles.stale} role="alert">거래 조건이 바뀌었습니다. 현재 금액으로 다시 만들어야 공유할 수 있습니다.</p> : null}
            <div className={styles.resultActions}>
              <button className={styles.primary} type="button" onClick={() => void share()} disabled={!resultShareable}>수취정보 공유</button>
              <button className={styles.secondary} type="button" onClick={() => void copyTarget()} disabled={!resultShareable}>
                {result.kind === "onchain" ? "주소만 복사" : "인보이스만 복사"}
              </button>
            </div>
          </div>
          <canvas
            ref={canvasRef}
            className={`${styles.qr} ${resultShareable ? "" : styles.qrUnavailable}`}
            aria-label={resultShareable ? "BTC 수취정보 QR" : "확인 중이거나 다시 만들어야 하는 BTC 수취정보 QR"}
          />
        </div>
      ) : null}
    </section>
  );
}
