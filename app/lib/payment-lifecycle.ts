export const PAYMENT_EXPIRING_THRESHOLD_SECONDS = 120;

export type PaymentExpiryState =
  | Readonly<{ status: "no-expiry"; expiresAtSeconds: null; remainingSeconds: null }>
  | Readonly<{ status: "ready" | "expiring" | "expired"; expiresAtSeconds: number; remainingSeconds: number }>;

/**
 * Classifies a payment request against an explicit clock. Keeping the clock as
 * an argument makes the 120-second boundary deterministic in UI and tests.
 */
export function getPaymentExpiryState(
  expiresAtSeconds: number | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1_000),
  expiringThresholdSeconds = PAYMENT_EXPIRING_THRESHOLD_SECONDS,
): PaymentExpiryState {
  if (expiresAtSeconds === null || expiresAtSeconds === undefined) {
    return Object.freeze({ status: "no-expiry", expiresAtSeconds: null, remainingSeconds: null });
  }
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= 0) {
    throw new RangeError("expiresAtSeconds must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    throw new RangeError("nowSeconds must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(expiringThresholdSeconds) || expiringThresholdSeconds < 1) {
    throw new RangeError("expiringThresholdSeconds must be a positive safe integer.");
  }

  const remainingSeconds = Math.max(0, expiresAtSeconds - nowSeconds);
  const status = remainingSeconds === 0
    ? "expired"
    : remainingSeconds < expiringThresholdSeconds
      ? "expiring"
      : "ready";
  return Object.freeze({ status, expiresAtSeconds, remainingSeconds });
}

export function isoTimeToEpochSeconds(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RangeError("The payment expiry time is invalid.");
  return Math.floor(milliseconds / 1_000);
}
