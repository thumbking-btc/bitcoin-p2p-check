"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { decodeQrSymbols } from "../lib/verified-qr.mjs";

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
  if (!lines[0] || /\s·\sP\s[+-]?\d/u.test(lines[0])) return text;
  lines[0] = `${lines[0]} · ${premium}`;
  return lines.join("\n");
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
  const resultCanvas = document.querySelector<HTMLCanvasElement>("canvas[aria-label='BTC 수취정보 QR']");
  if (resultCanvas) {
    const payload = readReceiveQrPayload();
    if (payload) {
      if (payload.toLowerCase().startsWith("bitcoin:")) {
        const address = document.querySelector<HTMLInputElement>("#receive-onchain")?.value.trim() ?? "";
        return [address ? `온체인 주소: ${address}` : "", `금액 지정 요청(BIP21): ${payload}`].filter(Boolean);
      }
      if (payload.toLowerCase().startsWith("lnbc") || payload.toLowerCase().startsWith("lightning:lnbc")) {
        return [`BOLT11: ${payload.replace(/^lightning:/iu, "")}`];
      }
    }
  }

  const onchain = document.querySelector<HTMLInputElement>("#receive-onchain");
  if (onchain && onchain.offsetParent !== null && onchain.value.trim()) {
    return [`온체인 주소: ${onchain.value.trim()}`];
  }

  const lightning = document.querySelector<HTMLInputElement>("#receive-lightning");
  if (lightning && lightning.offsetParent !== null && lightning.value.trim()) {
    const value = lightning.value.trim();
    return [`${value.includes("@") ? "라이트닝 주소" : "LNURL-pay"}: ${value}`];
  }

  const invoice = document.querySelector<HTMLTextAreaElement>("#receive-invoice");
  if (invoice && invoice.offsetParent !== null && invoice.value.trim()) {
    return [`BOLT11: ${invoice.value.trim().replace(/^lightning:/iu, "")}`];
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
      image.onerror = () => reject(new Error("QR 이미지를 읽지 못했습니다."));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function makeFourByThreeQrCard(file: File) {
  const image = await imageFromFile(file);
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 900;
  const context = canvas.getContext("2d");
  if (!context) return file;

  context.fillStyle = "#f5f0e3";
  context.fillRect(0, 0, 1200, 900);
  context.strokeStyle = "#101619";
  context.lineWidth = 4;
  context.strokeRect(30, 30, 1140, 840);
  context.fillStyle = "#101619";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.font = '800 48px "Pretendard Variable", Pretendard, sans-serif';
  context.fillText("BTC 수취정보", 72, 92);

  const amount = document.querySelector<HTMLElement>("[class*='amountNote'] b")?.textContent?.trim() ?? "";
  const maxQr = 560;
  const scale = Math.min(maxQr / image.naturalWidth, maxQr / image.naturalHeight, 1);
  const width = Math.round(image.naturalWidth * scale);
  const height = Math.round(image.naturalHeight * scale);
  const x = Math.round((1200 - width) / 2);
  const y = 175;
  context.fillStyle = "#fff";
  context.fillRect(x - 20, y - 20, width + 40, height + 40);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, x, y, width, height);

  if (amount) {
    context.fillStyle = "#101619";
    context.textAlign = "center";
    context.font = '800 34px "SFMono-Regular", Consolas, monospace';
    context.fillText(amount, 600, 825);
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

  useEffect(() => {
    document.documentElement.dataset.includePriceDetails = includeDetails ? "true" : "false";

    const sync = () => {
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

      const receiveSection = document.querySelector<HTMLElement>("[data-receive-info-portal] section");
      receiveSection?.querySelectorAll("button").forEach((button) => {
        if (button.textContent?.trim() === "주소 공유") button.hidden = true;
      });
    };

    const observer = new MutationObserver(() => {
      sync();
      window.setTimeout(sync, 60);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["value", "hidden"] });
    document.addEventListener("input", sync, true);
    document.addEventListener("change", sync, true);
    sync();

    const nativeShare = navigator.share?.bind(navigator);
    let restoreShare: (() => void) | null = null;
    if (nativeShare) {
      const wrappedShare = async (data?: ShareData) => {
        if (data?.title === "BTC 수취정보" && data.files?.length === 1 && data.files[0]?.type === "image/png") {
          try {
            const card = await makeFourByThreeQrCard(data.files[0]);
            return nativeShare({ ...data, files: [card] });
          } catch {
            return nativeShare(data);
          }
        }
        return nativeShare(data);
      };
      try {
        Object.defineProperty(navigator, "share", { configurable: true, value: wrappedShare });
        restoreShare = () => {
          try {
            delete (navigator as Navigator & { share?: Navigator["share"] }).share;
          } catch {
            return;
          }
        };
      } catch {
        restoreShare = null;
      }
    }

    return () => {
      observer.disconnect();
      document.removeEventListener("input", sync, true);
      document.removeEventListener("change", sync, true);
      restoreShare?.();
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
