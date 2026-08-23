const SATS_PER_BTC = 100_000_000;

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Formats the exact bitcoin amount in the user's selected display unit.
 * Whole 10,000-sat amounts use the compact Korean "만" form for sharing.
 *
 * @param {{ sats: number; bitcoinDisplayUnit?: "btc" | "sats" }} input
 */
export function formatTradeBitcoinAmount(input) {
  const sats = finitePositive(input.sats);
  if (sats === null) return "";
  const roundedSats = Math.round(sats);
  if (input.bitcoinDisplayUnit === "btc") {
    return `${(roundedSats / SATS_PER_BTC).toLocaleString("ko-KR", {
      maximumFractionDigits: 8,
      useGrouping: false,
    })} BTC`;
  }
  return roundedSats >= 10_000 && roundedSats % 10_000 === 0
    ? `${(roundedSats / 10_000).toLocaleString("ko-KR")}만 sats`
    : `${roundedSats.toLocaleString("ko-KR")} sats`;
}

/**
 * @param {{
 *   tradeRole: "buyer" | "seller";
 *   amountBasis?: "krw" | "bitcoin";
 *   paymentKrw: number;
 *   sats: number;
 *   bitcoinDisplayUnit?: "btc" | "sats";
 * }} input
 */
export function buildTradeIntent(input) {
  const paymentKrw = finitePositive(input.paymentKrw);
  const sats = finitePositive(input.sats);
  if (paymentKrw === null || sats === null) return "";

  const amountBasis = input.amountBasis ?? (input.tradeRole === "buyer" ? "krw" : "bitcoin");

  if (input.tradeRole === "buyer" && amountBasis === "krw") {
    return `비트코인 ${Math.round(paymentKrw).toLocaleString("ko-KR")}원어치 삽니다.`;
  }

  if (input.tradeRole === "seller" && amountBasis === "krw") {
    return `${Math.round(paymentKrw).toLocaleString("ko-KR")}원어치 BTC 팝니다.`;
  }

  if (amountBasis === "bitcoin" && (input.tradeRole === "buyer" || input.tradeRole === "seller")) {
    const action = input.tradeRole === "buyer" ? "삽니다." : "팝니다.";
    return `${formatTradeBitcoinAmount({ sats, bitcoinDisplayUnit: input.bitcoinDisplayUnit })} ${action}`;
  }

  return "";
}

/** @param {"buyer" | "seller"} tradeRole */
export function getTradeRecipientLabel(tradeRole) {
  if (tradeRole === "buyer") return "구매자가 받음";
  if (tradeRole === "seller") return "판매자가 받음";
  return "";
}
