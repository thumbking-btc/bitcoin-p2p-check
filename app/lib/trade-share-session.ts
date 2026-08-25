import { isReferenceShareable } from "./share-transport.mjs";
import { PAYMENT_EXPIRING_THRESHOLD_SECONDS } from "./payment-lifecycle.ts";
import type { TradeRecordApiSuccess } from "./trade-record";

export const LARGE_TRADE_CONFIRMATION_KRW = 1_000_000_000;

export type ShareAttemptCache = Readonly<{
  key: string;
  revokeToken: string;
  signed?: TradeRecordApiSuccess;
  file?: File;
}>;

export type ShareDeliveryOutcome = "shared" | "downloaded" | "downloaded-after-error";
export type VerificationUrlDelivery = "copied" | "copy-failed" | "available" | "unavailable";

export type PreparedTradeShare = Readonly<{
  key: string;
  revokeToken: string;
  signed: TradeRecordApiSuccess;
  file: File;
  text: string;
  title: string;
  deliveryOutcome?: ShareDeliveryOutcome;
  verificationUrlDelivery?: VerificationUrlDelivery;
}>;

export type ManagedTradeRecord = Readonly<{
  id: string;
  revokeToken: string;
  verificationUrl: string;
  lifecycle: "pending" | "finalized";
}>;

export type SharePreparationLifecycleStatus = "empty" | "ready" | "stale" | "expiring" | "expired";

export function createLargeTradeConfirmationKey({
  role,
  amountBasis,
  paymentKrw,
  sats,
}: Readonly<{
  role: "buyer" | "seller";
  amountBasis: "krw" | "bitcoin";
  paymentKrw: number;
  sats: number;
}>): string {
  if (paymentKrw < LARGE_TRADE_CONFIRMATION_KRW) return "";
  return JSON.stringify([role, amountBasis, paymentKrw, sats]);
}

export function tradeRecordPaymentExpiresAt(signed: TradeRecordApiSuccess): string | null {
  const payment = signed.record.payment;
  return payment?.rail === "lightning" && !payment.address ? payment.expiresAt ?? null : null;
}

export function isPaymentShareableAt(
  expiresAt: string | null,
  now = Date.now(),
): boolean {
  if (expiresAt === null) return true;
  if (!Number.isFinite(now)) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs)
    && expiresAtMs - now >= PAYMENT_EXPIRING_THRESHOLD_SECONDS * 1_000;
}

export function createShareAttempt(key: string, revokeToken: string): ShareAttemptCache {
  return Object.freeze({ key, revokeToken });
}

export function matchingShareAttempt(
  current: ShareAttemptCache | null,
  key: string,
): ShareAttemptCache | null {
  return current?.key === key ? current : null;
}

export function cacheAttemptRecord(
  attempt: ShareAttemptCache,
  signed: TradeRecordApiSuccess,
): ShareAttemptCache {
  return Object.freeze({ ...attempt, signed });
}

export function cacheAttemptFile(attempt: ShareAttemptCache, file: File): ShareAttemptCache {
  return Object.freeze({ ...attempt, file });
}

export function buildTradeRecordShareText(signed: TradeRecordApiSuccess): string {
  return [
    "비트코인 P2P 거래 기록 카드",
    signed.record.payment ? "확인된 결제정보가 카드의 QR에 포함되어 있습니다." : "결제정보를 포함하지 않은 조건 기록입니다.",
    `거래 정보 확인·복사: ${signed.verificationUrl}`,
    "주소·금액·입금·수령 내역을 상대방과 함께 확인하세요.",
  ].join("\n");
}

export function createPreparedTradeShare(
  attempt: ShareAttemptCache,
  signed: TradeRecordApiSuccess,
  file: File,
  title: string,
): PreparedTradeShare {
  return Object.freeze({
    key: attempt.key,
    revokeToken: attempt.revokeToken,
    signed,
    file,
    text: buildTradeRecordShareText(signed),
    title,
  });
}

export function recordShareDelivery(
  prepared: PreparedTradeShare,
  deliveryOutcome: ShareDeliveryOutcome,
  verificationUrlDelivery: VerificationUrlDelivery,
): PreparedTradeShare {
  return Object.freeze({ ...prepared, deliveryOutcome, verificationUrlDelivery });
}

export function isTradeShareTransitionSafe({
  currentAttemptKey,
  candidateAttemptKey,
  preparationAllowed,
  receiveInfoLifecycleStatus,
  marketObservedAt,
  paymentExpiresAt = null,
  now = Date.now(),
}: Readonly<{
  currentAttemptKey: string;
  candidateAttemptKey: string;
  preparationAllowed: boolean;
  receiveInfoLifecycleStatus: SharePreparationLifecycleStatus;
  marketObservedAt: string;
  paymentExpiresAt?: string | null;
  now?: number;
}>): boolean {
  return currentAttemptKey === candidateAttemptKey
    && preparationAllowed
    && receiveInfoLifecycleStatus !== "stale"
    && receiveInfoLifecycleStatus !== "expiring"
    && receiveInfoLifecycleStatus !== "expired"
    && isPaymentShareableAt(paymentExpiresAt, now)
    && isReferenceShareable({ marketState: "ready", referenceTime: marketObservedAt }, now);
}

export function toManagedTradeRecord(
  signed: TradeRecordApiSuccess,
  revokeToken: string,
  lifecycle: ManagedTradeRecord["lifecycle"] = signed.lifecycle ?? "pending",
): ManagedTradeRecord {
  return Object.freeze({
    id: signed.id,
    revokeToken,
    verificationUrl: signed.verificationUrl,
    lifecycle,
  });
}

export function upsertManagedTradeRecord(
  current: readonly ManagedTradeRecord[],
  record: ManagedTradeRecord,
): ManagedTradeRecord[] {
  return [...current.filter((item) => item.id !== record.id), record];
}

export function removeManagedTradeRecord(
  current: readonly ManagedTradeRecord[],
  recordId: string,
): ManagedTradeRecord[] {
  return current.filter((item) => item.id !== recordId);
}
