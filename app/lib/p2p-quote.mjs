export const SATS_PER_BTC = 100_000_000;
export const MAX_SATS = 2_100_000_000_000_000;
export const MIN_PREMIUM_PERCENT = -99.99;
export const MAX_PREMIUM_PERCENT = 999.99;

const PREMIUM_SCALE = 10_000n;
const PREMIUM_STEP_BPS = 10;
const MIN_PREMIUM_BPS = -9_999;
const MAX_PREMIUM_BPS = 99_999;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function premiumBasisPoints(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const basisPoints = Math.round(value * 100);
  if (!Number.isSafeInteger(basisPoints) || basisPoints / 100 !== value) return null;
  if (basisPoints < MIN_PREMIUM_BPS || basisPoints > MAX_PREMIUM_BPS) return null;
  return basisPoints;
}

export function isSupportedPremiumPercent(value) {
  return premiumBasisPoints(value) !== null;
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
  const result = nextBasisPoints / 100;
  return Object.is(result, -0) ? 0 : result;
}

function positiveSafeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= maximum;
}

function roundPositiveRational(numerator, denominator, maximum) {
  if (numerator <= 0n || denominator <= 0n) return null;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  if (rounded <= 0n || rounded > BigInt(maximum)) return null;
  return Number(rounded);
}

/**
 * Calculates a P2P quote with exact integer arithmetic and positive half-up rounding.
 *
 * @param {{
 *   mode: "krw" | "sats";
 *   amount: number;
 *   referencePrice: number;
 *   premiumPercent: number;
 * }} input
 */
export function calculateP2PQuote(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  if (input.mode !== "krw" && input.mode !== "sats") return null;
  if (!positiveSafeInteger(input.amount)) return null;
  if (!positiveSafeInteger(input.referencePrice)) return null;

  const premiumBps = premiumBasisPoints(input.premiumPercent);
  if (premiumBps === null) return null;
  if (input.mode === "sats" && input.amount > MAX_SATS) return null;

  const referencePrice = BigInt(input.referencePrice);
  const appliedPriceNumerator = referencePrice * BigInt(10_000 + premiumBps);
  if (appliedPriceNumerator > MAX_SAFE_INTEGER_BIGINT * PREMIUM_SCALE) return null;

  const sats = input.mode === "krw"
    ? roundPositiveRational(
        BigInt(input.amount) * BigInt(SATS_PER_BTC) * PREMIUM_SCALE,
        appliedPriceNumerator,
        MAX_SATS,
      )
    : input.amount;
  if (sats === null) return null;

  const paymentKrw = input.mode === "krw"
    ? input.amount
    : roundPositiveRational(
        BigInt(sats) * appliedPriceNumerator,
        BigInt(SATS_PER_BTC) * PREMIUM_SCALE,
        Number.MAX_SAFE_INTEGER,
      );
  if (paymentKrw === null) return null;

  const appliedPrice = Number(appliedPriceNumerator) / Number(PREMIUM_SCALE);
  if (!Number.isFinite(appliedPrice) || appliedPrice <= 0) return null;

  return {
    referencePrice: input.referencePrice,
    appliedPrice,
    premiumPercent: input.premiumPercent,
    paymentKrw,
    sats,
  };
}
