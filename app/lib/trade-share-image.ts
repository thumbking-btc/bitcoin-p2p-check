export type TradeShareImageInput = {
  tradeRole: "buyer" | "seller";
  referenceLabel: string;
  referencePriceKrw: number;
  referenceTime: string | number | Date | null;
  /** Decimal ratio: 0.02 means 2%. This is shown only as a market reference. */
  koreaPremiumRatio: number | null;
  sellerPremiumPercent: number;
  buyerFundingSource: string;
  paymentKrw: number;
  sats: number;
  btcAmount: number;
  appliedPriceKrw: number;
};

const WIDTH = 1_600;
const HEIGHT = 900;
const INK = "#101619";
const PAPER = "#f5f0e3";
const MUTED_PAPER = "#d9d1c1";
const ORANGE = "#f7931a";
const FONT_FAMILY = '"Pretendard Variable", Pretendard, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
// Canonical white mark from bitcoin.org/img/icons/logotop.svg.
// The vector already contains Bitcoin's characteristic 13.88° clockwise tilt.
const BITCOIN_MARK_PATH = "m241.91 70.689c0.637-4.258-2.605-6.547-7.038-8.074l1.438-5.768-3.511-0.875-1.4 5.616c-0.923-0.23-1.871-0.447-2.813-0.662l1.41-5.653-3.509-0.875-1.439 5.766c-0.764-0.174-1.514-0.346-2.242-0.527l0.004-0.018-4.842-1.209-0.934 3.75c0 0 2.605 0.597 2.55 0.634 1.422 0.355 1.679 1.296 1.636 2.042l-1.638 6.571c0.098 0.025 0.225 0.061 0.365 0.117-0.117-0.029-0.242-0.061-0.371-0.092l-2.296 9.205c-0.174 0.432-0.615 1.08-1.609 0.834 0.035 0.051-2.552-0.637-2.552-0.637l-1.743 4.019 4.569 1.139c0.85 0.213 1.683 0.436 2.503 0.646l-1.453 5.834 3.507 0.875 1.439-5.772c0.958 0.26 1.888 0.5 2.798 0.726l-1.434 5.745 3.511 0.875 1.453-5.823c5.987 1.133 10.489 0.676 12.384-4.739 1.527-4.36-0.076-6.875-3.226-8.515 2.294-0.529 4.022-2.038 4.483-5.155zm-8.022 11.249c-1.085 4.36-8.426 2.003-10.806 1.412l1.928-7.729c2.38 0.594 10.012 1.77 8.878 6.317zm1.086-11.312c-0.99 3.966-7.1 1.951-9.082 1.457l1.748-7.01c1.982 0.494 8.365 1.416 7.334 5.553z";

function assertFinitePositive(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number.`);
  }
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

function setFont(context: CanvasRenderingContext2D, size: number, weight = 700) {
  context.font = `${weight} ${size}px ${FONT_FAMILY}`;
}

function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  maximumWidth: number,
  preferredSize: number,
  minimumSize: number,
  weight = 700,
) {
  let size = preferredSize;
  setFont(context, size, weight);
  while (size > minimumSize && context.measureText(text).width > maximumWidth) {
    size -= 1;
    setFont(context, size, weight);
  }
  return size;
}

function formatKrw(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function formatSats(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")} sats`;
}

function formatBtc(value: number) {
  return `${value.toLocaleString("ko-KR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 8,
  })} BTC`;
}

function formatPercentFromRatio(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "조회 불가";
  return new Intl.NumberFormat("ko-KR", {
    style: "percent",
    signDisplay: "always",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
}

function formatReferenceTime(value: TradeShareImageInput["referenceTime"]) {
  if (value === null) return "조회 시각 없음";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "조회 시각 없음";
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

function drawPaperTexture(context: CanvasRenderingContext2D) {
  context.fillStyle = PAPER;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  context.save();
  context.globalAlpha = 0.045;
  context.fillStyle = INK;
  for (let index = 0; index < 1_500; index += 1) {
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
  context.arc(centerX, centerY, 31, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = INK;
  context.beginPath();
  context.arc(centerX, centerY - 9, 8, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.arc(centerX, centerY + 17, 17, Math.PI, 0);
  context.lineTo(centerX + 17, centerY + 22);
  context.lineTo(centerX - 17, centerY + 22);
  context.closePath();
  context.fill();
  context.restore();
}

function drawBitcoinMark(context: CanvasRenderingContext2D, centerX: number, centerY: number) {
  context.save();
  context.fillStyle = ORANGE;
  context.beginPath();
  context.arc(centerX, centerY, 104, 0, Math.PI * 2);
  context.fill();

  context.translate(centerX, centerY);
  context.fillStyle = "#ffffff";
  context.scale(3.25, 3.25);
  context.translate(-227.806, -75.247);
  context.fill(new Path2D(BITCOIN_MARK_PATH));
  context.restore();
}

function drawRule(context: CanvasRenderingContext2D, y: number) {
  context.save();
  context.strokeStyle = "rgba(245, 240, 227, 0.28)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(145, y);
  context.lineTo(1_255, y);
  context.stroke();
  context.restore();
}

function drawFlowRow(
  context: CanvasRenderingContext2D,
  options: {
    y: number;
    label: string;
    value: string;
    subvalue?: string;
    highlighted: boolean;
  },
) {
  const { y, label, value, subvalue, highlighted } = options;
  drawPersonIcon(context, 175, y);

  if (highlighted) {
    context.fillStyle = ORANGE;
    roundedRect(context, 220, y - 39, 9, 78, 5);
    context.fill();
  }

  context.fillStyle = PAPER;
  context.textAlign = "left";
  context.textBaseline = "middle";
  setFont(context, 38, 700);
  context.fillText(label, 260, y);

  context.fillStyle = highlighted ? ORANGE : PAPER;
  context.textAlign = "right";
  fitText(context, value, 515, 48, 33, 800);
  context.fillText(value, 1_205, subvalue ? y - 11 : y);

  if (subvalue) {
    context.fillStyle = MUTED_PAPER;
    setFont(context, 21, 500);
    context.fillText(subvalue, 1_205, y + 28);
  }
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
  const stamp = `${part("year")}${part("month")}${part("day")}-${part("hour")}${part("minute")}`;
  const action = role === "buyer" ? "buy" : "sell";
  return `bitcoin-p2p-${action}-trade-${stamp}.png`;
}

/**
 * Builds a shareable PNG using the user's current trade values.
 * This browser-only function intentionally has no dependency on the static OG image.
 */
export async function createTradeShareImage(input: TradeShareImageInput): Promise<File> {
  assertFinitePositive(input.referencePriceKrw, "referencePriceKrw");
  assertFinitePositive(input.paymentKrw, "paymentKrw");
  assertFinitePositive(input.sats, "sats");
  assertFinitePositive(input.btcAmount, "btcAmount");
  assertFinitePositive(input.appliedPriceKrw, "appliedPriceKrw");
  if (!Number.isFinite(input.sellerPremiumPercent) || input.sellerPremiumPercent <= -100) {
    throw new RangeError("sellerPremiumPercent must be finite and greater than -100.");
  }
  if (!input.buyerFundingSource.trim()) {
    throw new RangeError("buyerFundingSource must not be empty.");
  }
  if (typeof document === "undefined") {
    throw new Error("Trade share images can only be created in a browser.");
  }

  await document.fonts.ready;

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable.");

  drawPaperTexture(context);

  context.strokeStyle = INK;
  context.lineWidth = 5;
  context.strokeRect(34, 34, WIDTH - 68, HEIGHT - 68);

  context.fillStyle = INK;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  setFont(context, 68, 800);
  context.fillText("비트코인 P2P 거래 조건", 78, 136);

  context.fillStyle = ORANGE;
  roundedRect(context, 1_302, 78, 220, 62, 31);
  context.fill();
  context.fillStyle = INK;
  context.textAlign = "center";
  context.textBaseline = "middle";
  setFont(context, 24, 800);
  context.fillText(input.tradeRole === "buyer" ? "비트코인 구매" : "비트코인 판매", 1_412, 109);

  context.fillStyle = INK;
  roundedRect(context, 72, 180, 1_456, 628, 10);
  context.fill();

  context.strokeStyle = "rgba(245, 240, 227, 0.3)";
  context.lineWidth = 2;
  roundedRect(context, 96, 204, 1_408, 580, 6);
  context.stroke();

  context.fillStyle = MUTED_PAPER;
  context.textAlign = "left";
  context.textBaseline = "middle";
  setFont(context, 21, 600);
  context.fillText("비트코인 기준 가격", 130, 239);
  context.fillStyle = PAPER;
  fitText(context, input.referenceLabel, 410, 29, 21, 700);
  context.fillText(input.referenceLabel, 130, 276);

  const referencePriceText = `${formatKrw(input.referencePriceKrw)} / BTC`;
  context.textAlign = "right";
  context.fillStyle = PAPER;
  fitText(context, referencePriceText, 700, 48, 34, 800);
  context.fillText(referencePriceText, 1_425, 253);
  context.fillStyle = MUTED_PAPER;
  setFont(context, 20, 500);
  context.fillText(
    `조회 시각 ${formatReferenceTime(input.referenceTime)}`,
    1_425,
    292,
  );

  drawRule(context, 322);
  drawFlowRow(context, {
    y: 390,
    label: "구매자 → 판매자",
    value: formatKrw(input.paymentKrw),
    highlighted: input.tradeRole === "seller",
  });
  drawRule(context, 458);
  drawFlowRow(context, {
    y: 528,
    label: "판매자 → 구매자",
    value: formatSats(input.sats),
    subvalue: formatBtc(input.btcAmount),
    highlighted: input.tradeRole === "buyer",
  });
  drawRule(context, 598);

  context.fillStyle = PAPER;
  context.textAlign = "left";
  context.textBaseline = "middle";
  setFont(context, 25, 700);
  context.fillText("판매자 프리미엄", 145, 644);
  context.fillStyle = ORANGE;
  fitText(context, formatPercent(input.sellerPremiumPercent), 190, 39, 24, 800);
  context.fillText(formatPercent(input.sellerPremiumPercent), 385, 644);

  context.fillStyle = MUTED_PAPER;
  setFont(context, 21, 600);
  context.fillText("적용 단가", 620, 644);
  context.fillStyle = PAPER;
  setFont(context, 27, 700);
  context.fillText(`${formatKrw(input.appliedPriceKrw)} / BTC`, 742, 644);

  context.fillStyle = MUTED_PAPER;
  const fundingSourceLine = `구매자 자금 출처 · ${input.buyerFundingSource} · 구매자 제공 정보 · 거래 전 상호 확인`;
  fitText(context, fundingSourceLine, 1_080, 19, 15, 600);
  context.fillText(fundingSourceLine, 145, 688);

  context.fillStyle = MUTED_PAPER;
  setFont(context, 18, 500);
  const premiumReference = `시장 참고 · 업비트 프리미엄 ${formatPercentFromRatio(input.koreaPremiumRatio)}`;
  fitText(context, premiumReference, 1_080, 18, 14, 500);
  context.fillText(premiumReference, 145, 716);
  const calculationNote = "계산 기준 · 기준가 × (1 + 판매자 프리미엄) · 반올림 1 sat·1원 · 온체인 수수료 판매자 부담 · 구매자 수령량 차감 없음";
  fitText(context, calculationNote, 1_080, 18, 14, 500);
  context.fillText(calculationNote, 145, 744);
  context.fillStyle = ORANGE;
  const evidenceNote = "확인용 · 원화 입금·BTC 수령 증빙 아님";
  fitText(context, evidenceNote, 1_080, 17, 14, 700);
  context.fillText(evidenceNote, 145, 773);

  context.save();
  context.strokeStyle = "rgba(245, 240, 227, 0.38)";
  context.lineWidth = 2;
  context.setLineDash([8, 10]);
  context.beginPath();
  context.moveTo(1_270, 338);
  context.lineTo(1_270, 690);
  context.stroke();
  context.restore();
  drawBitcoinMark(context, 1_385, 500);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("PNG encoding failed."));
    }, "image/png");
  });

  return new File([blob], makeFilename(input.tradeRole), {
    type: "image/png",
    lastModified: Date.now(),
  });
}
