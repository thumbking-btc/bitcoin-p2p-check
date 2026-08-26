import { createVerifiedTextQr } from "./verified-qr.mjs";
import { formatTradeBitcoinAmount } from "./trade-share-copy.mjs";
import { getPaymentExpiryState } from "./payment-lifecycle";
import { inferDeploymentEnvironment } from "./deployment-environment.mjs";

export type TradeSharePayment = {
  rail: "onchain" | "lightning";
  payload: string;
  address?: string;
  expiresAt?: number;
};

export type TradeRecordReceipt = {
  id: string;
  createdAt: string;
  verificationUrl: string;
};

export type TradeShareImageInput = {
  tradeRole: "buyer" | "seller";
  amountBasis: "krw" | "bitcoin";
  bitcoinDisplayUnit: "btc" | "sats";
  referenceLabel: string;
  referencePriceKrw: number;
  referenceTime: string | number | Date | null;
  koreaPremiumRatio: number | null;
  sellerPremiumPercent: number;
  buyerFundingSource: string;
  paymentKrw: number;
  sats: number;
  btcAmount: number;
  appliedPriceKrw: string;
  payment: TradeSharePayment | null;
  record: TradeRecordReceipt;
};

const WIDTH = 1_440;
const HEIGHT = 1_080;
const INK = "#101619";
const PAPER = "#f5f0e3";
const MUTED_PAPER = "#d9d1c1";
const ORANGE = "#f7931a";
const FONT_FAMILY = '"Pretendard Variable", Pretendard, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const TRADE_SHARE_REQUEST_TYPE = "application/x-bitcoin-p2p-trade-image+json";
// Canonical white mark from bitcoin.org/img/icons/logotop.svg.
const BITCOIN_MARK_PATH = "m241.91 70.689c0.637-4.258-2.605-6.547-7.038-8.074l1.438-5.768-3.511-0.875-1.4 5.616c-0.923-0.23-1.871-0.447-2.813-0.662l1.41-5.653-3.509-0.875-1.439 5.766c-0.764-0.174-1.514-0.346-2.242-0.527l0.004-0.018-4.842-1.209-0.934 3.75c0 0 2.605 0.597 2.55 0.634 1.422 0.355 1.679 1.296 1.636 2.042l-1.638 6.571c0.098 0.025 0.225 0.061 0.365 0.117-0.117-0.029-0.242-0.061-0.371-0.092l-2.296 9.205c-0.174 0.432-0.615 1.08-1.609 0.834 0.035 0.051-2.552-0.637-2.552-0.637l-1.743 4.019 4.569 1.139c0.85 0.213 1.683 0.436 2.503 0.646l-1.453 5.834 3.507 0.875 1.439-5.772c0.958 0.26 1.888 0.5 2.798 0.726l-1.434 5.745 3.511 0.875 1.453-5.823c5.987 1.133 10.489 0.676 12.384-4.739 1.527-4.36-0.076-6.875-3.226-8.515 2.294-0.529 4.022-2.038 4.483-5.155zm-8.022 11.249c-1.085 4.36-8.426 2.003-10.806 1.412l1.928-7.729c2.38 0.594 10.012 1.77 8.878 6.317zm1.086-11.312c-0.99 3.966-7.1 1.951-9.082 1.457l1.748-7.01c1.982 0.494 8.365 1.416 7.334 5.553z";

function assertFinitePositive(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
}

function assertUnsignedIntegerText(value: string, name: string) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new RangeError(`${name} must be an unsigned integer string.`);
}

function validateInput(input: TradeShareImageInput) {
  assertFinitePositive(input.referencePriceKrw, "referencePriceKrw");
  assertFinitePositive(input.paymentKrw, "paymentKrw");
  assertFinitePositive(input.sats, "sats");
  assertFinitePositive(input.btcAmount, "btcAmount");
  assertUnsignedIntegerText(input.appliedPriceKrw, "appliedPriceKrw");
  if (!Number.isFinite(input.sellerPremiumPercent) || input.sellerPremiumPercent <= -100) {
    throw new RangeError("sellerPremiumPercent must be greater than -100.");
  }
  if (!input.record?.id || !input.record.createdAt || !input.record.verificationUrl) {
    throw new RangeError("A signed trade record is required.");
  }
  if (input.payment && (!input.payment.payload || !["onchain", "lightning"].includes(input.payment.rail))) {
    throw new RangeError("The payment request is invalid.");
  }
  if (input.payment?.rail === "lightning" && !input.payment.address) {
    if (!Number.isSafeInteger(input.payment.expiresAt) || Number(input.payment.expiresAt) <= 0) {
      throw new RangeError("A BOLT11 payment request requires an absolute expiry time.");
    }
    if (getPaymentExpiryState(input.payment.expiresAt).status !== "ready") {
      throw new RangeError("The BOLT11 payment request is expired or too close to expiry. Create a new invoice.");
    }
  }
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  if (typeof context.roundRect === "function") {
    context.roundRect(x, y, width, height, r);
    return;
  }
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

function fitText(context: CanvasRenderingContext2D, text: string, maximumWidth: number, preferredSize: number, minimumSize: number, weight = 700, mono = false) {
  let size = preferredSize;
  setFont(context, size, weight, mono);
  while (size > minimumSize && context.measureText(text).width > maximumWidth) {
    size -= 1;
    setFont(context, size, weight, mono);
  }
}

function formatKrw(value: number | string) {
  const integer = typeof value === "string" ? BigInt(value) : BigInt(Math.round(value));
  return `${integer.toLocaleString("ko-KR")}원`;
}

function formatPercent(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "" : "±";
  return `${sign}${value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
}

function formatRatio(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "조회 불가";
  return new Intl.NumberFormat("ko-KR", {
    style: "percent",
    signDisplay: "always",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTime(value: TradeShareImageInput["referenceTime"] | string) {
  if (value === null) return "시각 없음";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 없음";
  return `${new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date)} KST`;
}

function formatEpochSeconds(value: number) {
  return formatTime(new Date(value * 1_000));
}

function drawPaperTexture(context: CanvasRenderingContext2D) {
  context.fillStyle = PAPER;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.save();
  context.globalAlpha = 0.035;
  context.fillStyle = INK;
  for (let index = 0; index < 1_200; index += 1) {
    const x = (index * 97) % WIDTH;
    const y = (index * 53 + (index % 17) * 19) % HEIGHT;
    context.fillRect(x, y, index % 5 === 0 ? 2 : 1, 1);
  }
  context.restore();
}

function drawPersonIcon(context: CanvasRenderingContext2D, centerX: number, centerY: number) {
  context.save();
  context.fillStyle = PAPER;
  context.beginPath();
  context.arc(centerX, centerY, 29, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = INK;
  context.beginPath();
  context.arc(centerX, centerY - 8, 7, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.arc(centerX, centerY + 16, 15, Math.PI, 0);
  context.lineTo(centerX + 15, centerY + 21);
  context.lineTo(centerX - 15, centerY + 21);
  context.closePath();
  context.fill();
  context.restore();
}

function drawTransferRow(context: CanvasRenderingContext2D, options: { y: number; label: string; value: string; highlighted: boolean; badge?: string }) {
  drawPersonIcon(context, 125, options.y);
  if (options.highlighted) {
    context.fillStyle = ORANGE;
    roundedRect(context, 166, options.y - 38, 8, 76, 4);
    context.fill();
  }
  context.fillStyle = PAPER;
  context.textAlign = "left";
  context.textBaseline = "middle";
  setFont(context, 30, 750);
  context.fillText(options.label, 200, options.badge ? options.y - 13 : options.y);
  if (options.badge) {
    setFont(context, 18, 800);
    const width = Math.ceil(context.measureText(options.badge).width) + 28;
    context.fillStyle = ORANGE;
    roundedRect(context, 200, options.y + 13, width, 32, 16);
    context.fill();
    context.fillStyle = INK;
    context.textAlign = "center";
    context.fillText(options.badge, 200 + width / 2, options.y + 29);
  }
  context.fillStyle = options.highlighted ? ORANGE : PAPER;
  context.textAlign = "right";
  fitText(context, options.value, 330, 38, 27, 820);
  context.fillText(options.value, 840, options.y);
}

function drawRule(context: CanvasRenderingContext2D, y: number) {
  context.save();
  context.strokeStyle = "rgba(245, 240, 227, 0.27)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(90, y);
  context.lineTo(855, y);
  context.stroke();
  context.restore();
}

function drawBitcoinMark(context: CanvasRenderingContext2D, centerX: number, centerY: number, radius: number) {
  context.save();
  context.fillStyle = ORANGE;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fill();
  context.translate(centerX, centerY);
  context.fillStyle = "#fff";
  const scale = 2.9 * (radius / 92);
  context.scale(scale, scale);
  context.translate(-227.806, -75.247);
  context.fill(new Path2D(BITCOIN_MARK_PATH));
  context.restore();
}

function drawQr(context: CanvasRenderingContext2D, payload: string, maximumLength: number) {
  const qr = createVerifiedTextQr(payload, { maximumLength, maximumPixelSize: 460, level: "M" });
  const canvas = document.createElement("canvas");
  canvas.width = qr.width;
  canvas.height = qr.height;
  const qrContext = canvas.getContext("2d");
  if (!qrContext) {
    qr.data.fill(0);
    throw new Error("QR canvas is unavailable.");
  }
  const image = qrContext.createImageData(qr.width, qr.height);
  image.data.set(qr.data);
  qrContext.putImageData(image, 0, 0);
  image.data.fill(0);
  qr.data.fill(0);
  const x = 1_130 - canvas.width / 2;
  const y = 438 - canvas.height / 2;
  context.fillStyle = "#fff";
  roundedRect(context, x - 18, y - 18, canvas.width + 36, canvas.height + 36, 18);
  context.fill();
  context.imageSmoothingEnabled = false;
  context.drawImage(canvas, x, y);
  canvas.width = 1;
  canvas.height = 1;
}

function compactId(id: string) {
  return id.slice(0, 12).toUpperCase().match(/.{1,4}/gu)?.join("-") ?? id.toUpperCase();
}

function compactTarget(payment: TradeSharePayment) {
  if (payment.rail === "lightning") return payment.address ? payment.address : "고정금액 BOLT11 인보이스";
  const address = payment.address ?? payment.payload.replace(/^bitcoin:/iu, "").split("?")[0];
  return address.length > 30 ? `${address.slice(0, 16)}…${address.slice(-12)}` : address;
}

function makeFilename(role: TradeShareImageInput["tradeRole"]) {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => dateParts.find((item) => item.type === type)?.value ?? "00";
  return `bitcoin-p2p-${role === "buyer" ? "buy" : "sell"}-record-${part("year")}${part("month")}${part("day")}-${part("hour")}${part("minute")}.png`;
}

export async function createTradeShareImage(input: TradeShareImageInput): Promise<File> {
  validateInput(input);
  return new File([JSON.stringify(input)], `bitcoin-p2p-${input.tradeRole}-record.request`, {
    type: TRADE_SHARE_REQUEST_TYPE,
    lastModified: Date.now(),
  });
}

export async function materializeTradeShareImage(file: File): Promise<File> {
  if (file.type !== TRADE_SHARE_REQUEST_TYPE) return file;
  const input = JSON.parse(await file.text()) as TradeShareImageInput;
  validateInput(input);
  return renderTradeShareImage(input);
}

async function renderTradeShareImage(input: TradeShareImageInput): Promise<File> {
  if (typeof document === "undefined") throw new Error("Trade record cards require a browser.");
  await document.fonts.ready;

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable.");
  const stagingRecord = inferDeploymentEnvironment(new URL(input.record.verificationUrl).hostname) === "staging";

  drawPaperTexture(context);
  context.strokeStyle = INK;
  context.lineWidth = 4;
  context.strokeRect(1, 1, WIDTH - 2, HEIGHT - 2);
  context.fillStyle = INK;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  setFont(context, 54, 820);
  context.fillText("비트코인 P2P 거래 기록", 56, 92);
  drawBitcoinMark(context, 1_075, 74, 30);

  context.fillStyle = INK;
  context.textAlign = "right";
  context.textBaseline = "middle";
  setFont(context, 20, 760);
  context.fillText(stagingRecord ? "STAGING · TEST ONLY" : "서명된 공유 기록", 1_384, 74);

  context.fillStyle = INK;
  roundedRect(context, 40, 138, 1_360, 900, 14);
  context.fill();
  if (stagingRecord) {
    context.save();
    context.translate(WIDTH / 2, HEIGHT / 2);
    context.rotate(-Math.PI / 7);
    context.globalAlpha = 0.12;
    context.fillStyle = ORANGE;
    context.textAlign = "center";
    setFont(context, 112, 900);
    context.fillText("STAGING TEST RECORD", 0, 0);
    context.restore();
  }
  context.strokeStyle = "rgba(245, 240, 227, 0.34)";
  context.lineWidth = 2;
  roundedRect(context, 64, 164, 1_312, 846, 7);
  context.stroke();

  context.fillStyle = MUTED_PAPER;
  context.textAlign = "left";
  setFont(context, 23, 650);
  context.fillText("비트코인 기준 가격", 90, 204);
  context.fillStyle = PAPER;
  fitText(context, input.referenceLabel, 360, 34, 25, 760);
  context.fillText(input.referenceLabel, 90, 250);
  context.textAlign = "right";
  fitText(context, `${formatKrw(input.referencePriceKrw)} / BTC`, 430, 40, 29, 820);
  context.fillText(`${formatKrw(input.referencePriceKrw)} / BTC`, 850, 220);
  context.fillStyle = MUTED_PAPER;
  setFont(context, 18, 560);
  context.fillText(`시세 ${formatTime(input.referenceTime)}`, 850, 262);
  drawRule(context, 300);

  drawTransferRow(context, {
    y: 376,
    label: "구매자 → 판매자",
    value: formatKrw(input.paymentKrw),
    highlighted: input.tradeRole === "seller",
    badge: input.tradeRole === "seller" ? "판매자가 받음" : undefined,
  });
  drawRule(context, 452);
  drawTransferRow(context, {
    y: 528,
    label: "판매자 → 구매자",
    value: formatTradeBitcoinAmount({ sats: input.sats, bitcoinDisplayUnit: input.bitcoinDisplayUnit }),
    highlighted: input.tradeRole === "buyer",
    badge: input.tradeRole === "buyer" ? "구매자가 받음" : undefined,
  });
  drawRule(context, 604);

  context.textAlign = "left";
  context.fillStyle = PAPER;
  setFont(context, 25, 720);
  context.fillText("판매자 프리미엄", 90, 660);
  context.fillStyle = ORANGE;
  fitText(context, formatPercent(input.sellerPremiumPercent), 150, 36, 27, 840);
  context.fillText(formatPercent(input.sellerPremiumPercent), 326, 660);
  context.fillStyle = MUTED_PAPER;
  setFont(context, 21, 630);
  context.fillText("적용 BTC 단가", 477, 660);
  context.fillStyle = PAPER;
  fitText(context, formatKrw(input.appliedPriceKrw), 220, 27, 20, 760);
  context.fillText(formatKrw(input.appliedPriceKrw), 650, 660);

  const sourceIncluded = input.buyerFundingSource && input.buyerFundingSource !== "기재하지 않음" && input.buyerFundingSource !== "포함하지 않음";
  context.fillStyle = MUTED_PAPER;
  setFont(context, 20, 590);
  const detailLines = [
    sourceIncluded ? `구매자 자금 출처 · ${input.buyerFundingSource} · 구매자 제공 정보` : "구매자 자금 출처 · 포함하지 않음",
    `시장 참고 · 업비트 프리미엄 ${formatRatio(input.koreaPremiumRatio)}`,
    `계산 기준 · ${input.amountBasis === "krw" ? "원화 금액" : "비트코인 수량"} · 수수료 판매자 부담`,
  ];
  detailLines.forEach((line, index) => {
    fitText(context, line, 755, 20, 17, 590);
    context.fillText(line, 90, 724 + index * 42);
  });

  context.save();
  context.strokeStyle = "rgba(245, 240, 227, 0.38)";
  context.lineWidth = 2;
  context.setLineDash([8, 10]);
  context.beginPath();
  context.moveTo(870, 190);
  context.lineTo(870, 844);
  context.stroke();
  context.restore();

  const qrPayload = input.payment?.payload ?? input.record.verificationUrl;
  drawQr(context, qrPayload, input.payment ? 1_300 : 700);
  context.textAlign = "center";
  context.fillStyle = ORANGE;
  setFont(context, 27, 800);
  const paymentQrTitle = input.payment?.rail === "onchain"
    ? (/^bitcoin:/iu.test(input.payment.payload) ? "금액 포함 온체인 결제 QR" : "온체인 주소 QR")
    : input.payment?.rail === "lightning"
      ? (input.payment.address ? "라이트닝 주소 QR" : "고정금액 라이트닝 결제 QR")
      : "거래 기록 열기";
  context.fillText(paymentQrTitle, 1_130, 704);
  const paymentIncludesAmount = Boolean(input.payment && (
    (input.payment.rail === "onchain" && /^bitcoin:/iu.test(input.payment.payload))
    || (input.payment.rail === "lightning" && !input.payment.address)
  ));
  const addressOnly = Boolean(input.payment && !paymentIncludesAmount);
  context.fillStyle = addressOnly ? MUTED_PAPER : PAPER;
  const amountDescription = input.payment
    ? paymentIncludesAmount
      ? `${input.sats.toLocaleString("ko-KR")} sats 포함`
      : "QR에는 결제 금액이 포함되지 않음"
    : "보관용 링크 QR";
  fitText(context, amountDescription, 390, addressOnly ? 19 : 23, 15, 740);
  context.fillText(amountDescription, 1_130, 746);
  context.fillStyle = addressOnly ? PAPER : MUTED_PAPER;
  setFont(context, 18, 650);
  if (addressOnly) {
    const tradeAmountDescription = `거래 조건 금액 · ${input.sats.toLocaleString("ko-KR")} sats`;
    fitText(context, tradeAmountDescription, 390, 18, 14, 650);
    context.fillText(tradeAmountDescription, 1_130, 780);
  } else if (input.payment?.rail === "lightning" && input.payment.expiresAt) {
    const expiryDescription = `절대 만료 · ${formatEpochSeconds(input.payment.expiresAt)}`;
    fitText(context, expiryDescription, 390, 18, 14, 650);
    context.fillText(expiryDescription, 1_130, 780);
  }
  if (input.payment?.rail === "lightning" && !input.payment.address) {
    context.fillStyle = ORANGE;
    const expiryWarning = "단기 결제 요청 · 만료 후 새 인보이스 필요";
    fitText(context, expiryWarning, 390, 16, 13, 760);
    context.fillText(expiryWarning, 1_130, 812);
  }
  context.fillStyle = MUTED_PAPER;
  const target = input.payment ? compactTarget(input.payment) : `기록 ID ${compactId(input.record.id)}`;
  fitText(context, target, 390, 18, 14, 560, Boolean(input.payment));
  context.fillText(target, 1_130, 840);

  context.strokeStyle = "rgba(245, 240, 227, 0.28)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(90, 862);
  context.lineTo(1_350, 862);
  context.stroke();

  context.textAlign = "left";
  context.fillStyle = PAPER;
  setFont(context, 22, 780);
  context.fillText(`공유 기록 ID  ${compactId(input.record.id)}`, 90, 910);
  context.fillStyle = MUTED_PAPER;
  setFont(context, 17, 560);
  context.fillText(`생성 ${formatTime(input.record.createdAt)}`, 90, 946);
  fitText(context, input.record.verificationUrl, 690, 16, 13, 560, true);
  context.fillText(input.record.verificationUrl, 90, 978);
  context.textAlign = "right";
  context.fillStyle = ORANGE;
  setFont(context, 19, 760);
  context.fillText("거래 조건 확인·결제정보 복사 가능", 1_350, 916);
  context.fillStyle = MUTED_PAPER;
  setFont(context, 16, 560);
  context.fillText(stagingRecord ? "시험 기록 · 실제 거래 사용 금지" : "주소·금액·입금·수령 내역을 서로 확인", 1_350, 952);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error("PNG encoding failed.")), "image/png");
  });
  canvas.width = 1;
  canvas.height = 1;
  return new File([blob], makeFilename(input.tradeRole), { type: "image/png", lastModified: Date.now() });
}
