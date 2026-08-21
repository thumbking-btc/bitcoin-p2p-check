import { buildTradePromotion } from "./trade-promotion.mjs";

export type TradePromotionImageInput = {
  tradeRole: "buyer" | "seller";
  amountBasis: "krw" | "bitcoin";
  bitcoinDisplayUnit: "btc" | "sats";
  paymentKrw: number;
  sats: number;
  sellerPremiumPercent: number;
  transferSupport: "onchain" | "lightning" | "both";
};

const WIDTH = 1_600;
const HEIGHT = 900;
const INK = "#101619";
const PAPER = "#f5f0e3";
const MUTED = "#d9d1c1";
const ORANGE = "#f7931a";
const FONT = '"Pretendard Variable", Pretendard, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const BITCOIN_MARK_PATH = "m241.91 70.689c0.637-4.258-2.605-6.547-7.038-8.074l1.438-5.768-3.511-0.875-1.4 5.616c-0.923-0.23-1.871-0.447-2.813-0.662l1.41-5.653-3.509-0.875-1.439 5.766c-0.764-0.174-1.514-0.346-2.242-0.527l0.004-0.018-4.842-1.209-0.934 3.75c0 0 2.605 0.597 2.55 0.634 1.422 0.355 1.679 1.296 1.636 2.042l-1.638 6.571c0.098 0.025 0.225 0.061 0.365 0.117-0.117-0.029-0.242-0.061-0.371-0.092l-2.296 9.205c-0.174 0.432-0.615 1.08-1.609 0.834 0.035 0.051-2.552-0.637-2.552-0.637l-1.743 4.019 4.569 1.139c0.85 0.213 1.683 0.436 2.503 0.646l-1.453 5.834 3.507 0.875 1.439-5.772c0.958 0.26 1.888 0.5 2.798 0.726l-1.434 5.745 3.511 0.875 1.453-5.823c5.987 1.133 10.489 0.676 12.384-4.739 1.527-4.36-0.076-6.875-3.226-8.515 2.294-0.529 4.022-2.038 4.483-5.155zm-8.022 11.249c-1.085 4.36-8.426 2.003-10.806 1.412l1.928-7.729c2.38 0.594 10.012 1.77 8.878 6.317zm1.086-11.312c-0.99 3.966-7.1 1.951-9.082 1.457l1.748-7.01c1.982 0.494 8.365 1.416 7.334 5.553z";

function setFont(context: CanvasRenderingContext2D, size: number, weight = 700) {
  context.font = `${weight} ${size}px ${FONT}`;
}

function fitText(context: CanvasRenderingContext2D, text: string, width: number, preferred: number, minimum: number, weight = 700) {
  let size = preferred;
  setFont(context, size, weight);
  while (size > minimum && context.measureText(text).width > width) {
    size -= 1;
    setFont(context, size, weight);
  }
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawBitcoinMark(context: CanvasRenderingContext2D) {
  context.save();
  context.fillStyle = ORANGE;
  context.beginPath();
  context.arc(1_355, 477, 112, 0, Math.PI * 2);
  context.fill();
  context.translate(1_355, 477);
  context.fillStyle = "#fff";
  context.scale(3.5, 3.5);
  context.translate(-227.806, -75.247);
  context.fill(new Path2D(BITCOIN_MARK_PATH));
  context.restore();
}

function makeFilename(role: TradePromotionImageInput["tradeRole"]) {
  return `bitcoin-p2p-${role === "buyer" ? "buy" : "sell"}-recruitment.png`;
}

export async function createTradePromotionImage(input: TradePromotionImageInput): Promise<File> {
  const promotion = buildTradePromotion(input);
  if (!promotion) throw new RangeError("Invalid trade promotion input.");
  if (typeof document === "undefined") throw new Error("Promotion images require a browser.");
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable.");

  context.fillStyle = PAPER;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.strokeStyle = INK;
  context.lineWidth = 5;
  context.strokeRect(34, 34, WIDTH - 68, HEIGHT - 68);

  context.fillStyle = INK;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  setFont(context, 68, 800);
  context.fillText("비트코인 P2P 거래 모집", 78, 136);

  context.fillStyle = ORANGE;
  roundedRect(context, 1_315, 76, 207, 64, 32);
  context.fill();
  context.fillStyle = INK;
  context.textAlign = "center";
  context.textBaseline = "middle";
  setFont(context, 27, 850);
  context.fillText("공개용", 1_418, 108);

  context.fillStyle = INK;
  roundedRect(context, 72, 180, 1_456, 628, 10);
  context.fill();
  context.strokeStyle = "rgba(245, 240, 227, .3)";
  context.lineWidth = 2;
  roundedRect(context, 96, 204, 1_408, 580, 6);
  context.stroke();

  context.fillStyle = ORANGE;
  context.textAlign = "left";
  context.textBaseline = "middle";
  setFont(context, 24, 800);
  context.fillText(input.tradeRole === "buyer" ? "BTC 구매 희망" : "BTC 판매 희망", 140, 272);
  context.fillStyle = PAPER;
  fitText(context, promotion.intent, 1_000, 82, 50, 850);
  context.fillText(promotion.intent, 140, 370);
  context.fillStyle = MUTED;
  fitText(context, `작성 당시 시세·프리미엄 반영 · ${promotion.approximate}`, 1_000, 31, 23, 720);
  context.fillText(`작성 당시 시세·프리미엄 반영 · ${promotion.approximate}`, 140, 420);

  context.strokeStyle = "rgba(245, 240, 227, .3)";
  context.beginPath();
  context.moveTo(140, 458);
  context.lineTo(1_205, 458);
  context.stroke();

  context.fillStyle = MUTED;
  setFont(context, 23, 700);
  context.fillText("판매자 프리미엄", 140, 516);
  context.fillStyle = ORANGE;
  setFont(context, 48, 850);
  context.fillText(promotion.premium, 140, 572);

  context.fillStyle = MUTED;
  setFont(context, 23, 700);
  context.fillText(promotion.direction, 500, 516);
  context.fillStyle = PAPER;
  fitText(context, promotion.method, 690, 42, 28, 820);
  context.fillText(promotion.method, 500, 572);

  context.fillStyle = ORANGE;
  roundedRect(context, 140, 624, 1_065, 72, 8);
  context.fill();
  context.fillStyle = INK;
  setFont(context, 34, 850);
  fitText(context, "세부 조건 재확인 · 실제 송금은 DM에서 한 방식으로 확정", 985, 34, 25, 850);
  context.fillText("세부 조건 재확인 · 실제 송금은 DM에서 한 방식으로 확정", 180, 660);
  context.fillStyle = MUTED;
  setFont(context, 18, 650);
  context.fillText("확인용 · 거래·송금 증빙 아님 · 주소·인보이스·웹 링크 없음", 140, 744);
  drawBitcoinMark(context);

  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed.")), "image/png"));
  return new File([blob], makeFilename(input.tradeRole), { type: "image/png", lastModified: Date.now() });
}
