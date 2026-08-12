export const SATS_PER_BTC = 100_000_000;
export const MAX_SATS = 2_100_000_000_000_000;

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundedInteger(value, maximum) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded <= 0 || rounded > maximum) return null;
  return rounded;
}

/**
 * @param {{
 *   mode: "krw" | "sats";
 *   amount: number;
 *   referencePrice: number;
 *   premiumPercent: number;
 * }} input
 */
export function calculateP2PQuote(input) {
  const amount = finite(input.amount);
  const referencePrice = finite(input.referencePrice);
  const premiumPercent = finite(input.premiumPercent);

  if (input.mode !== "krw" && input.mode !== "sats") return null;
  if (amount === null || referencePrice === null || premiumPercent === null) return null;
  if (amount <= 0 || referencePrice <= 0 || premiumPercent <= -100) return null;

  const appliedPrice = referencePrice * (1 + premiumPercent / 100);
  if (!Number.isFinite(appliedPrice) || appliedPrice <= 0) return null;

  const sats = input.mode === "krw"
    ? roundedInteger((amount / appliedPrice) * SATS_PER_BTC, MAX_SATS)
    : roundedInteger(amount, MAX_SATS);
  if (sats === null) return null;

  const paymentKrw = input.mode === "krw"
    ? roundedInteger(amount, Number.MAX_SAFE_INTEGER)
    : roundedInteger((sats / SATS_PER_BTC) * appliedPrice, Number.MAX_SAFE_INTEGER);
  if (paymentKrw === null) return null;

  return {
    referencePrice,
    appliedPrice,
    premiumPercent,
    paymentKrw,
    sats,
  };
}
