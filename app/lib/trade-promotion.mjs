export const TRANSFER_SUPPORT_OPTIONS = Object.freeze(["onchain", "lightning", "both"]);

export function getTransferSupportLabel(tradeRole, transferSupport) {
  const direction = tradeRole === "buyer" ? "BTC 수령 가능 방식" : tradeRole === "seller" ? "BTC 전송 가능 방식" : "BTC 전송 방식";
  const method = transferSupport === "onchain"
      ? "온체인"
      : transferSupport === "lightning"
        ? "라이트닝"
        : transferSupport === "both"
        ? "온체인 또는 라이트닝"
        : "";
  return method ? { direction, method } : { direction: "", method: "" };
}

export function formatPromotionPremium(value) {
  if (!Number.isFinite(value) || value <= -100) return "";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
}

function formatBtcFromSats(sats) {
  const whole = Math.floor(sats / 100_000_000);
  const fraction = String(sats % 100_000_000).padStart(8, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction} BTC` : `${whole} BTC`;
}

export function buildTradePromotion(input) {
  if (!input || (input.tradeRole !== "buyer" && input.tradeRole !== "seller")) return null;
  if (input.amountBasis !== "krw" && input.amountBasis !== "bitcoin") return null;
  if (!TRANSFER_SUPPORT_OPTIONS.includes(input.transferSupport)) return null;
  let intent = "";
  if (!Number.isSafeInteger(input.paymentKrw) || input.paymentKrw <= 0 || !Number.isSafeInteger(input.sats) || input.sats <= 0) return null;
  if (input.amountBasis === "krw") {
    intent = input.tradeRole === "buyer"
      ? `비트코인 ${input.paymentKrw.toLocaleString("ko-KR")}원어치 삽니다.`
      : `${input.paymentKrw.toLocaleString("ko-KR")}원어치 BTC 팝니다.`;
  } else if (input.amountBasis === "bitcoin") {
    const action = input.tradeRole === "buyer" ? "삽니다." : "팝니다.";
    intent = input.bitcoinDisplayUnit === "btc"
      ? `${formatBtcFromSats(input.sats)} ${action}`
      : `${input.sats.toLocaleString("ko-KR")} sats ${action}`;
  }
  const approximate = input.amountBasis === "krw"
    ? `약 ${input.bitcoinDisplayUnit === "btc" ? formatBtcFromSats(input.sats) : `${input.sats.toLocaleString("ko-KR")} sats`}`
    : `약 ${input.paymentKrw.toLocaleString("ko-KR")}원`;
  const premium = formatPromotionPremium(input.sellerPremiumPercent);
  const transfer = getTransferSupportLabel(input.tradeRole, input.transferSupport);
  if (!intent || !premium || !transfer.method) return null;
  const title = `${intent.slice(0, -1)} · ${transfer.method}`;
  const text = [
    "[공개용 · 비트코인 P2P 거래 모집]",
    intent,
    `작성 당시 시세·프리미엄 반영: ${approximate}`,
    `판매자 프리미엄: ${premium}`,
    `${transfer.direction}: ${transfer.method}`,
    "세부 조건을 다시 확인하고, 실제 송금은 DM에서 한 방식으로 확정합니다.",
    "확인용: 거래·송금 증빙 아님",
  ].join("\n");
  return Object.freeze({ approximate, intent, premium, text, title, ...transfer });
}
