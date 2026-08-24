"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { decodeQrSymbols } from "../lib/verified-qr.mjs";

type TransformWindow = Window & {
  __p2pTransformTradeShareFile?: (file: File) => Promise<File>;
};

function compactShareText(text: string) {
  const marker = "\n[가격 계산]\n";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return text;
  const verificationMarker = "\n\n거래 조건 검증하기:";
  const verificationIndex = text.indexOf(verificationMarker, markerIndex + marker.length);
  const head = text.slice(0, markerIndex).trimEnd();
  if (verificationIndex < 0) return head;
  return `${head}${text.slice(verificationIndex)}`;
}

function formatPremium() {
  const input = document.querySelector<HTMLInputElement>("#seller-premium");
  if (!input) return "";
  const value = Number(input.value);
  if (!Number.isFinite(value)) return "";
  const sign = value > 0 ? "+" : "";
  return `P ${sign}${value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
}

function withPremium(text: string) {
  const premium = formatPremium();
  if (!premium || !text) return text;
  const lines = text.split("\n");
  if (!lines[0]) return text;
  lines[0] = lines[0].replace(/\s·\sP\s[+-]?[\d,.]+%$/u, "");
  lines[0] = `${lines[0]} · ${premium}`;
  return lines.join("\n");
}

function visibleValue(selector: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!field || field.offsetParent === null) return "";
  return field.value.trim();
}

function readReceiveQrPayload() {
  const canvas = document.querySelector<HTMLCanvasElement>("canvas[aria-label='BTC 수취정보 QR']");
  if (!canvas || canvas.width < 1 || canvas.height < 1) return "";
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return "";
  try {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const symbols = decodeQrSymbols(image);
    image.data.fill(0);
    return symbols.length === 1 ? symbols[0] : "";
  } catch {
    return "";
  }
}

function receiveShareLines() {
  const payload = readReceiveQrPayload();
  if (payload) {
    const lower = payload.toLowerCase();
    if (lower.startsWith("bitcoin:")) {
      const address = visibleValue("#receive-onchain");
      return [address ? `온체인 주소: ${address}` : "", `금액 지정 요청(BIP21): ${payload}`].filter(Boolean);
    }
    if (lower.startsWith("lnbc") || lower.startsWith("lightning:lnbc")) {
      return [`BOLT11: ${payload.replace(/^lightning:/iu, "")}`];
    }
  }

  const onchain = visibleValue("#receive-onchain");
  if (onchain) return [`온체인 주소: ${onchain}`];

  const lightning = visibleValue("#receive-lightning");
  if (lightning) {
    return [`${lightning.includes("@") ? "라이트닝 주소" : "LNURL-pay"}: ${lightning}`];
  }

  return [];
}

function withReceiveInfo(text: string) {
  const lines = receiveShareLines();
  if (!lines.length) return text;
  const block = `[BTC 받을 정보]\n${lines.join("\n")}`;
  const marker = "\n\n거래 조건 검증하기:";
  const index = text.indexOf(marker);
  return index >= 0
    ? `${text.slice(0, index).trimEnd()}\n\n${block}${text.slice(index)}`
    : `${text.trimEnd()}\n\n${block}`;
}

async function imageFromFile(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("거래 조건 이미지를 읽지 못했습니다."));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawFittedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maximumWidth: number,
  preferredSize: number,
  minimumSize: number,
  weight = 700,
) {
  let size = preferredSize;
  context.font = `${weight} ${size}px "Pretendard Variable", Pretendard, "Noto Sans KR", sans-serif`;
  while (size > minimumSize && context.measureText(text).width > maximumWidth) {
    size -= 1;
    context.font = `${weight} ${size}px "Pretendard Variable", Pretendard, "Noto Sans KR", sans-serif`;
  }
  context.fillText(text, x, y);
}

function receiveImageSummary(hasQr: boolean) {
  const onchain = visibleValue("#receive-onchain");
  if (onchain) {
    return {
      label: "온체인",
      value: onchain,
      note: hasQr ? "QR에는 거래 금액이 포함된 BIP21 요청이 들어 있습니다." : "주소는 함께 공유되는 문구에 포함됩니다.",
    };
  }

  const lightning = visibleValue("#receive-lightning");
  if (lightning) {
    return {
      label: hasQr ? "라이트닝 인보이스" : "라이트닝 주소",
      value: hasQr ? "BOLT11 인보이스 · QR 또는 함께 공유되는 문구 사용" : lightning,
      note: hasQr ? `원래 주소 · ${lightning}` : "주소는 함께 공유되는 문구에 포함됩니다.",
    };
  }

  if (hasQr) {
    return {
      label: "라이트닝 인보이스",
      value: "BOLT11 인보이스 · QR 또는 함께 공유되는 문구 사용",
      note: "검증된 결제 요청입니다.",
    };
  }

  return {
    label: "수취정보 미입력",
    value: "거래 조건만 공유됩니다.",
    note: "",
  };
}

async function makeFourByThreeTradeCard(file: File) {
  const image = await imageFromFile(file);
  const canvas = document.createElement("canvas");
  canvas.width = 1_200;
  canvas.height = 900;
  const context = canvas.getContext("2d");
  if (!context) return file;

  context.fillStyle = "#f5f0e3";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, 1_200, 675);

  context.strokeStyle = "#101619";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(26, 676);
  context.lineTo(1_174, 676);
  context.stroke();

  const receiveCanvas = document.querySelector<HTMLCanvasElement>("canvas[aria-label='BTC 수취정보 QR']");
  const hasQr = Boolean(receiveCanvas && receiveCanvas.width > 0 && receiveCanvas.height > 0);
  const summary = receiveImageSummary(hasQr);
  const textWidth = hasQr ? 820 : 1_070;

  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillStyle = "#101619";
  context.font = '800 28px "Pretendard Variable", Pretendard, "Noto Sans KR", sans-serif';
  context.fillText("BTC 받을 정보", 48, 716);

  context.fillStyle = "#a94d00";
  context.font = '800 19px "Pretendard Variable", Pretendard, "Noto Sans KR", sans-serif';
  context.fillText(summary.label, 48, 755);

  context.fillStyle = "#101619";
  drawFittedText(context, summary.value, 48, 798, textWidth, 23, 14, 700);
  if (summary.note) {
    context.fillStyle = "#5f665f";
    drawFittedText(context, summary.note, 48, 837, textWidth, 17, 12, 600);
  }

  if (hasQr && receiveCanvas) {
    const qrSize = 170;
    const qrX = 982;
    const qrY = 700;
    context.fillStyle = "#ffffff";
    context.fillRect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16);
    context.imageSmoothingEnabled = false;
    context.drawImage(receiveCanvas, qrX, qrY, qrSize, qrSize);
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = 1;
  canvas.height = 1;
  return blob ? new File([blob], file.name, { type: "image/png", lastModified: Date.now() }) : file;
}

export function ShareDetailsPreference() {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [includeDetails, setIncludeDetails] = useState(false);
  const baseTextRef = useRef("");
  const renderedTextRef = useRef("");
  const scheduledRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.includePriceDetails = includeDetails ? "true" : "false";
    const transformWindow = window as TransformWindow;
    transformWindow.__p2pTransformTradeShareFile = makeFourByThreeTradeCard;

    const sync = () => {
      scheduledRef.current = null;
      const details = document.querySelector<HTMLElement>(".trade-share-preview");
      const pre = details?.querySelector<HTMLPreElement>("pre[aria-label='거래 조건 이미지와 함께 공유되는 문구']");
      if (!details || !pre) {
        setMount(null);
        return;
      }

      let host = details.querySelector<HTMLElement>("[data-share-details-preference]");
      if (!host) {
        host = document.createElement("div");
        host.dataset.shareDetailsPreference = "true";
        pre.insertAdjacentElement("afterend", host);
      }
      setMount(host);

      const current = pre.textContent ?? "";
      if (current !== renderedTextRef.current) baseTextRef.current = current;
      const base = baseTextRef.current || current;
      const compacted = includeDetails ? base : compactShareText(base);
      const desired = withReceiveInfo(withPremium(compacted));
      renderedTextRef.current = desired;
      document.documentElement.dataset.currentTradeShareText = desired;
      if (current !== desired) pre.textContent = desired;
    };

    const scheduleSync = () => {
      if (scheduledRef.current !== null) return;
      scheduledRef.current = window.requestAnimationFrame(sync);
    };

    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    document.addEventListener("input", scheduleSync, true);
    document.addEventListener("change", scheduleSync, true);
    scheduleSync();

    return () => {
      observer.disconnect();
      document.removeEventListener("input", scheduleSync, true);
      document.removeEventListener("change", scheduleSync, true);
      if (scheduledRef.current !== null) window.cancelAnimationFrame(scheduledRef.current);
      scheduledRef.current = null;
      delete transformWindow.__p2pTransformTradeShareFile;
      delete document.documentElement.dataset.includePriceDetails;
      delete document.documentElement.dataset.currentTradeShareText;
    };
  }, [includeDetails]);

  if (!mount) return null;
  return createPortal(
    <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px", marginTop: "1px", borderTop: "1px solid var(--line)", background: "#f7f3ea" }}>
      <input id="share-details-toggle" type="checkbox" checked={includeDetails} onChange={(event) => setIncludeDetails(event.target.checked)} />
      <label htmlFor="share-details-toggle" style={{ display: "grid", gap: "1px", cursor: "pointer" }}>
        <strong style={{ fontSize: "12px" }}>상세 계산정보 포함</strong>
        <small style={{ color: "var(--muted)", fontSize: "10px" }}>선택 사항 · 가격 계산 근거까지 함께 보냅니다.</small>
      </label>
    </div>,
    mount,
  );
}
