import { validateBolt11Invoice } from "./bolt11-invoice.mjs";
import { createP2PReceiveRequest, formatSatsAsBtcAmount } from "./p2p-receive-request.mjs";
import { createVerifiedTextQr, verifyQrRasterPayload } from "./verified-qr.mjs";

type CommonInput = {
  fundingSource: string;
  paymentKrw: number;
  sats: number;
  validUntil: number;
};

export type PrivateRequestImageInput = CommonInput & (
  | { rail: "onchain"; address: string; uri: string }
  | { rail: "lightning"; invoice: string }
);

const WIDTH = 1_200;
const HEIGHT = 1_500;
const INK = "#101619";
const PAPER = "#f5f0e3";
const MUTED = "#d9d1c1";
const ORANGE = "#f7931a";
const FONT = '"Pretendard Variable", Pretendard, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

function setFont(context: CanvasRenderingContext2D, size: number, weight = 700, mono = false) {
  context.font = `${weight} ${size}px ${mono ? '"SFMono-Regular", Consolas, monospace' : FONT}`;
}

function fitText(context: CanvasRenderingContext2D, text: string, width: number, preferred: number, minimum: number, weight = 700, mono = false) {
  let size = preferred;
  setFont(context, size, weight, mono);
  while (size > minimum && context.measureText(text).width > width) {
    size -= 1;
    setFont(context, size, weight, mono);
  }
}

function formatKrw(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function formatSats(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")} sats`;
}

function formatExpiry(value: number) {
  return `${new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))} KST`;
}

function splitFixed(text: string, length: number) {
  const lines = [];
  for (let index = 0; index < text.length; index += length) lines.push(text.slice(index, index + length));
  return lines;
}

function validateInput(input: PrivateRequestImageInput) {
  if (!Number.isSafeInteger(input.sats) || input.sats <= 0 || !Number.isSafeInteger(input.paymentKrw) || input.paymentKrw <= 0) {
    throw new RangeError("Invalid private request amount.");
  }
  if (!Number.isFinite(input.validUntil) || input.validUntil <= Date.now()) throw new RangeError("Private request expired.");
  if (typeof input.fundingSource !== "string" || !input.fundingSource.trim() || input.fundingSource.length > 64) {
    throw new RangeError("Invalid funding source.");
  }
  if (input.rail === "onchain") {
    const request = createP2PReceiveRequest({
      address: input.address,
      addressConfirmed: true,
      amountConfirmed: true,
      sats: BigInt(input.sats),
    });
    if (request.uri !== input.uri) throw new RangeError("On-chain request mismatch.");
    return { payload: request.uri, canonical: request.address };
  }
  if (input.rail === "lightning") {
    const invoice = validateBolt11Invoice(input.invoice, {
      expectedSats: BigInt(input.sats),
      minimumRemainingSeconds: 0,
    });
    return { payload: invoice.canonicalInvoice.toUpperCase(), canonical: invoice.canonicalInvoice };
  }
  throw new RangeError("Unsupported payment rail.");
}

export async function createPrivateRequestImage(input: PrivateRequestImageInput): Promise<File> {
  if (typeof document === "undefined") throw new Error("Private request images require a browser.");
  const verified = validateInput(input);
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D is unavailable.");
  context.fillStyle = PAPER;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.strokeStyle = INK;
  context.lineWidth = 5;
  context.strokeRect(34, 34, WIDTH - 68, HEIGHT - 68);

  context.fillStyle = INK;
  context.textAlign = "left";
  context.textBaseline = "middle";
  setFont(context, 58, 850);
  context.fillText("BTC 송금 요청", 74, 115);
  context.fillStyle = ORANGE;
  context.beginPath();
  context.roundRect(850, 70, 276, 70, 35);
  context.fill();
  context.fillStyle = INK;
  context.textAlign = "center";
  setFont(context, 24, 850);
  context.fillText("1:1 전달용", 988, 105);

  context.fillStyle = INK;
  context.beginPath();
  context.roundRect(70, 180, 1_060, 1_220, 12);
  context.fill();
  context.fillStyle = ORANGE;
  context.textAlign = "left";
  setFont(context, 27, 850);
  context.fillText(input.rail === "onchain" ? "온체인 · 판매자가 보내고 구매자가 받음" : "라이트닝 · 판매자가 보내고 구매자가 받음", 120, 242);
  context.fillStyle = PAPER;
  setFont(context, 63, 850, true);
  context.fillText(formatSats(input.sats), 120, 330);
  context.fillStyle = MUTED;
  setFont(context, 23, 650);
  context.fillText(`${formatSatsAsBtcAmount(BigInt(input.sats))} BTC · 고정 원화 조건 ${formatKrw(input.paymentKrw)}`, 120, 382);

  const qr = createVerifiedTextQr(verified.payload, { maximumLength: 1_200, maximumPixelSize: 580, level: "M" });
  const qrCanvas = document.createElement("canvas");
  qrCanvas.width = qr.width;
  qrCanvas.height = qr.height;
  const qrContext = qrCanvas.getContext("2d");
  if (!qrContext) {
    qr.data.fill(0);
    throw new Error("QR canvas unavailable.");
  }
  const qrImage = qrContext.createImageData(qr.width, qr.height);
  qrImage.data.set(qr.data);
  qrContext.putImageData(qrImage, 0, 0);
  const qrX = Math.round((WIDTH - qr.width) / 2);
  context.drawImage(qrCanvas, qrX, 430);
  qrImage.data.fill(0);

  context.fillStyle = MUTED;
  context.textAlign = "center";
  setFont(context, 21, 650);
  context.fillText(input.rail === "onchain" ? "QR에는 전체 주소와 정확한 BTC 금액이 들어 있습니다" : "QR에는 전체 BOLT11 인보이스와 정확한 금액이 들어 있습니다", WIDTH / 2, 430 + qr.height + 38);

  context.textAlign = "left";
  let detailsY = 430 + qr.height + 92;
  context.fillStyle = ORANGE;
  setFont(context, 21, 800);
  context.fillText(input.rail === "onchain" ? "전체 수취 주소" : "인보이스 식별값", 120, detailsY);
  context.fillStyle = PAPER;
  setFont(context, input.rail === "onchain" ? 23 : 20, 650, true);
  const detail = input.rail === "onchain"
    ? verified.canonical
    : `${verified.canonical.slice(0, 28)}…${verified.canonical.slice(-28)}`;
  for (const line of splitFixed(detail, input.rail === "onchain" ? 38 : 58)) {
    detailsY += 34;
    context.fillText(line, 120, detailsY);
  }

  detailsY += 52;
  context.fillStyle = MUTED;
  setFont(context, 20, 650);
  context.fillText(`구매자 자금 출처 · ${input.fundingSource} · 구매자 제공 정보`, 120, detailsY);
  detailsY += 38;
  context.fillText(`${input.rail === "onchain" ? "채굴" : "라우팅"} 수수료 · 판매자 별도 부담 · 구매자 수령량 차감 없음`, 120, detailsY);
  detailsY += 38;
  context.fillText(`상호 재확인 기한 · ${formatExpiry(input.validUntil)}`, 120, detailsY);

  context.fillStyle = ORANGE;
  context.beginPath();
  context.roundRect(120, 1_320, 960, 70, 8);
  context.fill();
  context.fillStyle = INK;
  context.textAlign = "center";
  fitText(context, "원화 선송금은 BTC 지급을 보장하지 않습니다", 900, 31, 24, 850);
  context.fillText("원화 선송금은 BTC 지급을 보장하지 않습니다", WIDTH / 2, 1_355);
  context.fillStyle = MUTED;
  setFont(context, 18, 650);
  context.fillText("확인용 · 결제·입금·확정 증빙 아님 · 공유된 파일은 자동 만료·회수되지 않음", WIDTH / 2, 1_420);

  const fullImage = context.getImageData(0, 0, WIDTH, HEIGHT);
  try {
    verifyQrRasterPayload(fullImage, verified.payload);
  } finally {
    fullImage.data.fill(0);
    qr.data.fill(0);
    qrCanvas.width = 0;
    qrCanvas.height = 0;
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed.")), "image/png"));
  return new File([blob], "bitcoin-p2p-private-request.png", { type: "image/png", lastModified: Date.now() });
}
