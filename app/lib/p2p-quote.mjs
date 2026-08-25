export const SATS_PER_BTC = 100_000_000;
export const MAX_SATS = 2_100_000_000_000_000;
export const MAX_KRW = 999_999_999_999_999;
export const MIN_PREMIUM_BPS = -9_999;
export const MAX_PREMIUM_BPS = 99_999;
export const MAX_PREMIUM_PERCENT = MAX_PREMIUM_BPS / 100;

const PREMIUM_STEP_BPS = 10;

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

function premiumBasisPoints(value) {
  if (!Number.isFinite(value)) return null;
  const basisPoints = Math.round(value * 100);
  if (!Number.isSafeInteger(basisPoints)) return null;
  if (Math.abs(basisPoints / 100 - value) > Number.EPSILON * Math.max(1, Math.abs(value)) * 4) return null;
  if (basisPoints < MIN_PREMIUM_BPS || basisPoints > MAX_PREMIUM_BPS) return null;
  return basisPoints;
}

export function roundedAppliedPriceKrw(referencePrice, premiumBps) {
  if (!Number.isSafeInteger(referencePrice) || referencePrice <= 0 || referencePrice > MAX_KRW) return null;
  if (!Number.isSafeInteger(premiumBps) || premiumBps < MIN_PREMIUM_BPS || premiumBps > MAX_PREMIUM_BPS) return null;
  const numerator = BigInt(referencePrice) * BigInt(10_000 + premiumBps);
  return ((numerator + 5_000n) / 10_000n).toString();
}

function roundedRatio(numerator, denominator, maximum) {
  if (numerator <= 0n || denominator <= 0n) return null;
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  if (rounded <= 0n || rounded > BigInt(maximum)) return null;
  return Number(rounded);
}

export function stepPremiumPercent(value, direction) {
  if (direction !== -1 && direction !== 1) return null;
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) return null;

  const currentBasisPoints = value === null ? 0 : Math.round(value * 100);
  if (!Number.isSafeInteger(currentBasisPoints) || (value !== null && currentBasisPoints / 100 !== value)) return null;

  const nextBasisPoints = Math.min(
    MAX_PREMIUM_BPS,
    Math.max(MIN_PREMIUM_BPS, currentBasisPoints + direction * PREMIUM_STEP_BPS),
  );
  if (!Number.isSafeInteger(nextBasisPoints)) return null;
  const result = nextBasisPoints / 100;
  return Object.is(result, -0) ? 0 : result;
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
  if (amount <= 0 || !Number.isSafeInteger(referencePrice) || referencePrice <= 0 || referencePrice > MAX_KRW) return null;

  const premiumBps = premiumBasisPoints(premiumPercent);
  if (premiumBps === null) return null;
  const priceFactor = 10_000 + premiumBps;
  const appliedPriceNumerator = BigInt(referencePrice) * BigInt(priceFactor);
  const appliedPriceKrw = roundedAppliedPriceKrw(referencePrice, premiumBps);
  if (appliedPriceKrw === null) return null;

  const integerAmount = roundedInteger(amount, input.mode === "krw" ? MAX_KRW : MAX_SATS);
  if (integerAmount === null) return null;

  const sats = input.mode === "krw"
    ? roundedRatio(
        BigInt(integerAmount) * BigInt(SATS_PER_BTC) * 10_000n,
        appliedPriceNumerator,
        MAX_SATS,
      )
    : integerAmount;
  if (sats === null) return null;

  const paymentKrw = input.mode === "krw"
    ? integerAmount
    : roundedRatio(
        BigInt(sats) * appliedPriceNumerator,
        BigInt(SATS_PER_BTC) * 10_000n,
        MAX_KRW,
      );
  if (paymentKrw === null) return null;

  return {
    referencePrice,
    appliedPriceKrw,
    premiumPercent,
    paymentKrw,
    sats,
  };
}
