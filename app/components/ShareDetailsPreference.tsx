"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { decodeQrSymbols } from "../lib/verified-qr.mjs";

type TransformWindow = Window & {
  __p2pTransformTradeShareFile?: (file: File) => Promise<File>;
};

type TradeImageSnapshot = {
  role: "buyer" | "seller";
  referenceLabel: string;
  referencePrice: string;
  referenceTime: string;
  payment: string;
  bitcoin: string;
  premium: string;
  appliedPrice: string;
  fundingSource: string;
  marketPremium: string;
};

const CARD_WIDTH = 1_440;
const CARD_HEIGHT = 1_080;
const PAPER = "#f5f0e3";
const INK = "#101619";
const MUTED = "#d9d1c1";
const ORANGE = "#f7931a";
const FONT_FAMILY = '"Pretendard Variable", Pretendard, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

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

function receiveCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>("canvas[aria-label='BTC 수취정보 QR']");
  return canvas && canvas.width > 0 && canvas.height > 0 ? canvas : null;
}

function readReceiveQrPayload() {
  const canvas = receiveCanvas();
  if (!canvas) return "";
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
  if (lightning) return [`${lightning.includes("@") ? "라이트닝 주소" : "LNURL-pay"}: ${lightning}`];

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

function lineValue(text: string, prefix: string) {
  const line = text.split("\n").find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

function makeSnapshot(): TradeImageSnapshot | null {
  const source = document.documentElement.dataset.fullTradeShareText
    || document.documentElement.dataset.currentTradeShareText
    || "";
  if (!source) return null;

  const firstLine = source.split("\n")[0] ?? "";
  const role: TradeImageSnapshot["role"] = firstLine.includes("팝니다") ? "seller" : "buyer";
  const reference = lineValue(source, "기준:");
  const referenceMatch = reference.match(/^(.*?)\s+([\d,]+원\s*\/\s*BTC)$/u);
  const premiumInput = formatPremium().replace(/^P\s*/u, "");

  return {
    role,
    referenceLabel: referenceMatch?.[1]?.trim() || "업비트 최근 체결가",
    referencePrice: referenceMatch?.[2]?.trim() || reference || "—",
    referenceTime: lineValue(source, "계산 시각:") || "조회 시각 없음",
    payment: lineValue(source, "구매자 → 판매자:") || "—",
    bitcoin: lineValue(source, "판매자 → 구매자:") || "—",
    premium: premiumInput || lineValue(source, "판매자 프리미엄:") || "0%",
    appliedPrice: lineValue(source, "판매자가 파는 BTC 가격:") || "—",
    fundingSource: lineValue(source, "구매자 자금 출처:").replace(/\s*\(구매자 제공 정보.*$/u, "") || "기재하지 않음",
    marketPremium: lineValue(source, "참고 업비트 프리미엄:") || "조회 불가",
  };
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function setFont(context: CanvasRenderingContext2D, size: number, weight = 700, mono = false) {
  context.font = `${weight} ${size}px ${mono ? '"SFMono-Regular", Consolas, monospace' : FONT_FAMILY}`;
}

function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  maximumWidth: number,
  preferredSize: number,
  minimumSize: number,
  weight = 700,
  mono = false,
) {
  let size = preferredSize;
  setFont(context, size, weight, mono);
  while (size > minimumSize && context.measureText(text).width > maximumWidth) {
    size -= 1;
    setFont(context, size, weight, mono);
  }
  return size;
}

function drawPaperTexture(context: CanvasRenderingContext2D) {
  context.fillStyle = PAPER;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  context.save();
  context.globalAlpha = 0.035;
  context.fillStyle = INK;
  for (let index = 0; index < 1_200; index += 1) {
    const x = (index * 97) % CARD_WIDTH;
    const y = (index * 53 + (index % 17) * 19) % CARD_HEIGHT;
    context.fillRect(x, y, index % 5 === 0 ? 2 : 1, 1);
  }
  context.restore();
}

function drawPersonIcon(context: CanvasRenderingContext2D, centerX: number, centerY: number) {
  context.save();
  context.fillStyle = PAPER;
  context.beginPath();
  context.arc(centerX, centerY, 32, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = INK;
  context.beginPath();
  context.arc(centerX, centerY - 9, 8, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.arc(centerX, centerY + 18, 17, Math.PI, 0);
  context.lineTo(centerX + 17, centerY + 23);
  context.lineTo(centerX - 17, centerY + 23);
  context.closePath();
  context.fill();
  context.restore();
}

function drawRule(context: CanvasRenderingContext2D, y: number) {
  context.save();
  context.strokeStyle = "rgba(245, 240, 227, 0.28)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(100, y);
  context.lineTo(920, y);
  context.stroke();
  context.restore();
}

function drawTransferRow(
  context: CanvasRenderingContext2D,
  options: { y: number; label: string; value: string; highlighted: boolean; badge?: string },
) {
  drawPersonIcon(context, 132, options.y);
  if (options.highlighted) {
    context.fillStyle = ORANGE;
    roundedRect(context, 174, options.y - 40, 8, 80, 4);
    context.fill();
  }

  context.fillStyle = PAPER;
  context.textAlign = "left";
  context.textBaseline = "middle";
  setFont(context, 34, 750);
  context.fillText(options.label, 208, options.badge ? options.y - 14 : options.y);

  if (options.badge) {
    setFont(context, 18, 800);
    const badgeWidth = Math.ceil(context.measureText(options.badge).width) + 30;
    context.fillStyle = ORANGE;
    roundedRect(context, 208, options.y + 14, badgeWidth, 34, 17);
    context.fill();
    context.fillStyle = INK;
    context.textAlign = "center";
    context.fillText(options.badge, 208 + badgeWidth / 2, options.y + 31);
  }

  context.fillStyle = options.highlighted ? ORANGE : PAPER;
  context.textAlign = "right";
  fitText(context, options.value, 430, 43, 29, 820);
  context.fillText(options.value, 890, options.y);
}

function qrCaption(payload: string) {
  const lower = payload.toLowerCase();
  if (lower.startsWith("bitcoin:")) return "온체인 결제 QR";
  if (lower.startsWith("lnbc") || lower.startsWith("lightning:lnbc")) return "라이트닝 인보이스 QR";
  return "BTC 수취 QR";
}

function receiveFallback() {
  const onchain = visibleValue("#receive-onchain");
  if (onchain) return { title: "온체인 주소", value: onchain };
  const lightning = visibleValue("#receive-lightning");
  if (lightning) return { title: lightning.includes("@") ? "라이트닝 주소" : "LNURL-pay", value: lightning };
  return { title: "BTC 받을 정보", value: "수취정보를 입력하지 않았습니다." };
}

async function makeFourByThreeTradeCard(file: File) {
  const snapshot = makeSnapshot();
  if (!snapshot) return file;
  await document.fonts.ready;

  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return file;

  drawPaperTexture(context);
  context.strokeStyle = INK;
  context.lineWidth = 4;
  context.strokeRect(1, 1, CARD_WIDTH - 2, CARD_HEIGHT - 2);

  context.fillStyle = INK;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  setFont(context, 58, 820);
  context.fillText("비트코인 P2P 거래 조건", 56, 92);

  context.fillStyle = ORANGE;
  roundedRect(context, 1_170, 42, 218, 64, 32);
  context.fill();
  context.fillStyle = INK;
  context.textAlign = "center";
  context.textBaseline = "middle";
  setFont(context, 25, 820);
  context.fillText(snapshot.role === "buyer" ? "비트코인 구매" : "비트코인 판매", 1_279, 74);

  context.fillStyle = INK;
  roundedRect(context, 40, 138, 1_360, 900, 14);
  context.fill();
  context.strokeStyle = "rgba(245, 240, 227, 0.35)";
  context.lineWidth = 2;
  roundedRect(context, 64, 166, 1_312, 842, 7);
  context.stroke();

  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillStyle = MUTED;
  setFont(context, 22, 650);
  context.fillText("비트코인 기준 가격", 100, 210);
  context.fillStyle = PAPER;
  fitText(context, snapshot.referenceLabel, 440, 32, 22, 760);
  context.fillText(snapshot.referenceLabel, 100, 254);

  context.textAlign = "right";
  context.fillStyle = PAPER;
  fitText(context, snapshot.referencePrice, 520, 46, 32, 820);
  context.fillText(snapshot.referencePrice, 910, 224);
  context.fillStyle = MUTED;
  setFont(context, 19, 550);
  context.fillText(`조회 시각 ${snapshot.referenceTime}`, 910, 270);
  drawRule(context, 308);

  drawTransferRow(context, {
    y: 388,
    label: "구매자 → 판매자",
    value: snapshot.payment,
    highlighted: snapshot.role === "seller",
    badge: snapshot.role === "seller" ? "판매자가 받음" : undefined,
  });
  drawRule(context, 466);
  drawTransferRow(context, {
    y: 548,
    label: "판매자 → 구매자",
    value: snapshot.bitcoin,
    highlighted: snapshot.role === "buyer",
    badge: snapshot.role === "buyer" ? "구매자가 받음" : undefined,
  });
  drawRule(context, 626);

  context.textAlign = "left";
  context.fillStyle = PAPER;
  setFont(context, 25, 730);
  context.fillText("판매자 프리미엄", 100, 690);
  context.fillStyle = ORANGE;
  fitText(context, snapshot.premium, 180, 39, 26, 840);
  context.fillText(snapshot.premium, 348, 690);

  context.fillStyle = MUTED;
  setFont(context, 21, 650);
  context.fillText("적용 단가", 500, 690);
  context.fillStyle = PAPER;
  fitText(context, snapshot.appliedPrice, 330, 29, 20, 760);
  context.fillText(snapshot.appliedPrice, 626, 690);

  context.fillStyle = MUTED;
  setFont(context, 19, 600);
  const fundingLine = `구매자 자금 출처 · ${snapshot.fundingSource} · 구매자 제공 정보 · 거래 전 상호 확인`;
  fitText(context, fundingLine, 810, 19, 15, 600);
  context.fillText(fundingLine, 100, 770);
  const marketLine = `시장 참고 · 업비트 프리미엄 ${snapshot.marketPremium}`;
  fitText(context, marketLine, 810, 18, 14, 560);
  context.fillText(marketLine, 100, 816);
  const calculationLine = "계산 · 기준가 × (1 + 판매자 프리미엄) · 온체인 수수료 판매자 부담 · 구매자 수령량 차감 없음";
  fitText(context, calculationLine, 810, 18, 14, 560);
  context.fillText(calculationLine, 100, 862);

  context.fillStyle = ORANGE;
  setFont(context, 19, 760);
  context.fillText("확인용 · 원화 입금·BTC 수령 증빙 아님", 100, 950);

  context.save();
  context.strokeStyle = "rgba(245, 240, 227, 0.4)";
  context.lineWidth = 2;
  context.setLineDash([8, 10]);
  context.beginPath();
  context.moveTo(960, 330);
  context.lineTo(960, 920);
  context.stroke();
  context.restore();

  const qr = receiveCanvas();
  const payload = readReceiveQrPayload();
  if (qr && payload) {
    const qrSize = 314;
    const qrX = 1_020;
    const qrY = 360;
    context.fillStyle = PAPER;
    roundedRect(context, qrX - 24, qrY - 24, qrSize + 48, qrSize + 48, 20);
    context.fill();
    context.imageSmoothingEnabled = false;
    context.drawImage(qr, qrX, qrY, qrSize, qrSize);
    context.fillStyle = PAPER;
    context.textAlign = "center";
    setFont(context, 24, 730);
    context.fillText(qrCaption(payload), qrX + qrSize / 2, 735);
    context.fillStyle = MUTED;
    setFont(context, 17, 560);
    context.fillText("스캔하면 현재 거래의 BTC 수취정보를 불러옵니다.", qrX + qrSize / 2, 780);
  } else {
    const fallback = receiveFallback();
    context.textAlign = "center";
    context.fillStyle = ORANGE;
    setFont(context, 22, 800);
    context.fillText(fallback.title, 1_165, 470);
    context.fillStyle = PAPER;
    fitText(context, fallback.value, 300, 21, 13, 650, true);
    context.fillText(fallback.value, 1_165, 525);
    context.fillStyle = MUTED;
    setFont(context, 16, 560);
    context.fillText("QR을 만들면 이 영역에 결제 QR이 표시됩니다.", 1_165, 580);
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
      const full = withPremium(base);
      document.documentElement.dataset.fullTradeShareText = full;
      const compacted = includeDetails ? full : compactShareText(full);
      const desired = withReceiveInfo(compacted);
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
      delete document.documentElement.dataset.fullTradeShareText;
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
