import { isReferenceShareable } from "./share-transport.mjs";
import { PAYMENT_EXPIRING_THRESHOLD_SECONDS } from "./payment-lifecycle.ts";
import {
  isTradeRecordId,
  getTradeRecordRetentionPolicy,
  TRADE_RECORD_RETENTION_POLICIES,
  TRADE_RECORD_RETENTION_SECONDS,
  TRADE_RECORD_REVOKE_TOKEN_PATTERN,
  type TradeRecordApiSuccess,
} from "./trade-record.ts";

export const LARGE_TRADE_CONFIRMATION_KRW = 1_000_000_000;
export const LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY = "bitcoin-p2p-helper:managed-trade-records:v1";
export const MANAGED_TRADE_RECORD_STORAGE_PREFIX = "bitcoin-p2p-helper:managed-trade-record:v2:";
const MAX_LEGACY_MANAGED_RECORD_STORAGE_BYTES = 65_536;
const MAX_MANAGED_RECORD_STORAGE_BYTES = 2_048;
const PENDING_MANAGEMENT_TTL_MS = 15 * 60 * 1_000;
export const MANAGED_TRADE_RECORD_CLOCK_SKEW_GRACE_MS = 24 * 60 * 60 * 1_000;

export type ManagedTradeRecordStorage = Pick<
  Storage,
  "getItem" | "key" | "length" | "removeItem" | "setItem"
>;

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
  lifecycle: "pending" | "finalizing" | "finalized";
  expiresAt: string;
  retentionSeconds?: number;
  persistence: "memory-only" | "browser";
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
  const pendingCreatedAtMs = Date.parse(signed.record.createdAt);
  if ((lifecycle === "pending" || lifecycle === "finalizing") && !Number.isFinite(pendingCreatedAtMs)) {
    throw new TypeError("준비 거래 기록의 생성 시각을 확인하지 못했습니다.");
  }
  return Object.freeze({
    id: signed.id,
    revokeToken,
    verificationUrl: signed.verificationUrl,
    lifecycle,
    expiresAt: lifecycle === "pending"
      ? new Date(pendingCreatedAtMs + PENDING_MANAGEMENT_TTL_MS).toISOString()
      : signed.record.expiresAt,
    retentionSeconds: (
      getTradeRecordRetentionPolicy(signed.record.schema)
      ?? getTradeRecordRetentionPolicy("bitcoin-p2p-trade-record/v1")
    ).retentionSeconds,
    persistence: "memory-only",
  });
}

function isExactManagedRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const legacyKeys = ["expiresAt", "id", "lifecycle", "revokeToken", "verificationUrl"];
  const currentKeys = ["expiresAt", "id", "lifecycle", "retentionSeconds", "revokeToken", "verificationUrl"];
  return (keys.length === legacyKeys.length && keys.every((key, index) => key === legacyKeys[index]))
    || (keys.length === currentKeys.length && keys.every((key, index) => key === currentKeys[index]));
}

function restoredManagedRecord(
  value: unknown,
  expectedOrigin: string,
  now: number,
  includeExpired = false,
): ManagedTradeRecord | null {
  if (!isExactManagedRecord(value)
    || !isTradeRecordId(value.id)
    || typeof value.revokeToken !== "string"
    || !TRADE_RECORD_REVOKE_TOKEN_PATTERN.test(value.revokeToken)
    || (value.lifecycle !== "pending" && value.lifecycle !== "finalizing" && value.lifecycle !== "finalized")
    || typeof value.expiresAt !== "string") return null;
  const expiresAtMs = Date.parse(value.expiresAt);
  const retentionSeconds = value.retentionSeconds === undefined
    ? TRADE_RECORD_RETENTION_SECONDS
    : Number(value.retentionSeconds);
  if (!Number.isSafeInteger(retentionSeconds)
    || !Object.values(TRADE_RECORD_RETENTION_POLICIES).some((policy) => policy.retentionSeconds === retentionSeconds)) return null;
  const managementExpiresAtMs = value.lifecycle === "finalizing"
    ? expiresAtMs - retentionSeconds * 1_000 + PENDING_MANAGEMENT_TTL_MS
    : expiresAtMs;
  const maximumRemainingMs = value.lifecycle === "pending"
    ? PENDING_MANAGEMENT_TTL_MS
    : TRADE_RECORD_RETENTION_SECONDS * 1_000;
  if (!Number.isFinite(expiresAtMs)
    || !Number.isFinite(managementExpiresAtMs)
    || new Date(expiresAtMs).toISOString() !== value.expiresAt
    || (!includeExpired
      && managementExpiresAtMs + MANAGED_TRADE_RECORD_CLOCK_SKEW_GRACE_MS <= now)
    || expiresAtMs - now > maximumRemainingMs + MANAGED_TRADE_RECORD_CLOCK_SKEW_GRACE_MS
    || typeof value.verificationUrl !== "string"
    || value.verificationUrl.length > 512) return null;

  let verificationUrl: URL;
  let canonicalVerificationUrl: URL;
  try {
    verificationUrl = new URL(value.verificationUrl);
    canonicalVerificationUrl = new URL(`/verify/?id=${value.id}`, expectedOrigin);
  } catch {
    return null;
  }
  if (verificationUrl.href !== canonicalVerificationUrl.href) return null;

  return Object.freeze({
    id: value.id,
    revokeToken: value.revokeToken,
    verificationUrl: verificationUrl.toString(),
    lifecycle: value.lifecycle,
    expiresAt: value.expiresAt,
    retentionSeconds,
    persistence: "browser",
  });
}

export function managedTradeRecordStorageKey(recordId: string): string {
  if (!isTradeRecordId(recordId)) throw new TypeError("거래 기록 ID를 확인하지 못했습니다.");
  return `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${recordId}`;
}

export function parseManagedTradeRecordStorageKey(key: string | null): string | null {
  if (typeof key !== "string" || !key.startsWith(MANAGED_TRADE_RECORD_STORAGE_PREFIX)) return null;
  const recordId = key.slice(MANAGED_TRADE_RECORD_STORAGE_PREFIX.length);
  return isTradeRecordId(recordId) ? recordId : null;
}

export function parsePersistedManagedTradeRecord(
  serialized: string | null,
  expectedOrigin: string,
  now = Date.now(),
): ManagedTradeRecord | null {
  return parseStoredManagedTradeRecord(serialized, expectedOrigin, now, false);
}

function parseStoredManagedTradeRecord(
  serialized: string | null,
  expectedOrigin: string,
  now: number,
  includeExpired: boolean,
): ManagedTradeRecord | null {
  if (serialized === null
    || serialized === ""
    || !Number.isFinite(now)
    || new TextEncoder().encode(serialized).byteLength > MAX_MANAGED_RECORD_STORAGE_BYTES) return null;
  try {
    return restoredManagedRecord(JSON.parse(serialized) as unknown, expectedOrigin, now, includeExpired);
  } catch {
    return null;
  }
}

export function parsePersistedManagedTradeRecords(
  serialized: string | null,
  expectedOrigin: string,
  now = Date.now(),
): ManagedTradeRecord[] {
  if (serialized === null || serialized === "") return [];
  if (!Number.isFinite(now)
    || new TextEncoder().encode(serialized).byteLength > MAX_LEGACY_MANAGED_RECORD_STORAGE_BYTES) return [];
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const records: ManagedTradeRecord[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const record = restoredManagedRecord(candidate, expectedOrigin, now);
    if (!record || record.lifecycle !== "finalized" || ids.has(record.id)) continue;
    ids.add(record.id);
    records.push(record);
  }
  return records;
}

export function serializeManagedTradeRecords(
  current: readonly ManagedTradeRecord[],
  now = Date.now(),
): string {
  const records = current
    .filter((record) => (
      record.lifecycle === "finalized" && managedTradeRecordCleanupAt(record) > now
    ))
    .map(({ id, revokeToken, verificationUrl, lifecycle, expiresAt, retentionSeconds }) => ({
      id,
      revokeToken,
      verificationUrl,
      lifecycle,
      expiresAt,
      ...(retentionSeconds === undefined ? {} : { retentionSeconds }),
    }));
  return JSON.stringify(records);
}

function serializeManagedTradeRecord(
  record: ManagedTradeRecord,
  expectedOrigin: string,
  now: number,
): string {
  const serialized = JSON.stringify({
    id: record.id,
    revokeToken: record.revokeToken,
    verificationUrl: record.verificationUrl,
    lifecycle: record.lifecycle,
    expiresAt: record.expiresAt,
    ...(record.retentionSeconds === undefined ? {} : { retentionSeconds: record.retentionSeconds }),
  });
  const restored = parsePersistedManagedTradeRecord(serialized, expectedOrigin, now);
  if (!restored || restored.id !== record.id) {
    throw new TypeError("브라우저에 보관할 철회 권한을 확인하지 못했습니다.");
  }
  return serialized;
}

export function persistManagedTradeRecord(
  storage: ManagedTradeRecordStorage,
  record: ManagedTradeRecord,
  expectedOrigin: string,
  now = Date.now(),
): ManagedTradeRecord {
  const serialized = serializeManagedTradeRecord(record, expectedOrigin, now);
  const key = managedTradeRecordStorageKey(record.id);
  const existing = parsePersistedManagedTradeRecord(storage.getItem(key), expectedOrigin, now);
  if (existing?.id === record.id) {
    if (existing.revokeToken !== record.revokeToken) {
      throw new Error("같은 거래 기록에 서로 다른 철회 권한이 저장되어 있습니다.");
    }
    if (managedRecordLifecycleRank(existing.lifecycle) > managedRecordLifecycleRank(record.lifecycle)) {
      return existing;
    }
  }
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) {
    throw new Error("브라우저가 철회 권한 저장을 확인하지 못했습니다.");
  }
  return Object.freeze({ ...record, persistence: "browser" });
}

export function removePersistedManagedTradeRecord(
  storage: ManagedTradeRecordStorage,
  recordId: string,
): void {
  storage.removeItem(managedTradeRecordStorageKey(recordId));
}

export function loadPersistedManagedTradeRecords(
  storage: ManagedTradeRecordStorage,
  expectedOrigin: string,
  now = Date.now(),
): ManagedTradeRecord[] {
  if (!Number.isFinite(now)) throw new TypeError("철회 권한 복원 시각을 확인하지 못했습니다.");
  let origin: URL;
  try {
    origin = new URL(expectedOrigin);
  } catch {
    throw new TypeError("철회 권한 복원 origin을 확인하지 못했습니다.");
  }
  if (origin.origin !== expectedOrigin || origin.username || origin.password) {
    throw new TypeError("철회 권한 복원 origin을 확인하지 못했습니다.");
  }
  const legacySerialized = storage.getItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY);
  const legacyRecords = parsePersistedManagedTradeRecords(
    legacySerialized,
    expectedOrigin,
    now,
  );
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(MANAGED_TRADE_RECORD_STORAGE_PREFIX)) keys.push(key);
  }

  let records: ManagedTradeRecord[] = [];
  const scopedRecords = new Map<string, ManagedTradeRecord>();
  for (const key of keys) {
    const recordId = parseManagedTradeRecordStorageKey(key);
    const serialized = storage.getItem(key);
    const record = parsePersistedManagedTradeRecord(serialized, expectedOrigin, now);
    if (!recordId || !record || record.id !== recordId) {
      const expired = recordId
        ? parseStoredManagedTradeRecord(serialized, expectedOrigin, now, true)
        : null;
      if (expired?.id === recordId && managedTradeRecordCleanupAt(expired) <= now) {
        try {
          storage.removeItem(key);
        } catch {
          // A later hydration can retry removing a structurally valid expired capability.
        }
      }
      continue;
    }
    scopedRecords.set(record.id, record);
    records = upsertManagedTradeRecord(records, record);
  }

  if (legacySerialized !== null && legacyRecords.length === 0) {
    try {
      storage.removeItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY);
    } catch {
      // A later hydration can retry removing an invalid or expired legacy snapshot.
    }
  } else if (legacyRecords.length > 0) {
    let migrationComplete = true;
    for (const record of legacyRecords) {
      const scoped = scopedRecords.get(record.id);
      if (scoped && scoped.revokeToken !== record.revokeToken) {
        migrationComplete = false;
        continue;
      }
      const preferred = scoped
        ? upsertManagedTradeRecord([scoped], record)[0]
        : record;
      try {
        const persisted = scoped && preferred === scoped
          ? scoped
          : persistManagedTradeRecord(storage, preferred, expectedOrigin, now);
        records = upsertManagedTradeRecord(records, persisted);
      } catch {
        migrationComplete = false;
        records = upsertManagedTradeRecord(records, preferred);
      }
    }
    if (migrationComplete) {
      try {
        storage.removeItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY);
      } catch {
        // Keeping the legacy copy is safe and permits migration to be retried.
      }
    }
  }

  return records;
}

export function pruneExpiredManagedTradeRecords(
  current: readonly ManagedTradeRecord[],
  now = Date.now(),
): ManagedTradeRecord[] {
  return current.filter((record) => managedTradeRecordCleanupAt(record) > now);
}

export function managedTradeRecordCleanupAt(record: ManagedTradeRecord): number {
  const managementExpiresAt = managedTradeRecordPendingExpiresAt(record) ?? record.expiresAt;
  const expiresAtMs = Date.parse(managementExpiresAt);
  return Number.isFinite(expiresAtMs)
    ? expiresAtMs + MANAGED_TRADE_RECORD_CLOCK_SKEW_GRACE_MS
    : Number.NaN;
}

export function managedTradeRecordPendingExpiresAt(record: ManagedTradeRecord): string | null {
  if (record.lifecycle === "pending") return record.expiresAt;
  if (record.lifecycle !== "finalizing") return null;
  const finalExpiryMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(finalExpiryMs)) return null;
  return new Date(
    finalExpiryMs - (record.retentionSeconds ?? TRADE_RECORD_RETENTION_SECONDS) * 1_000 + PENDING_MANAGEMENT_TTL_MS,
  ).toISOString();
}

function managedRecordLifecycleRank(lifecycle: ManagedTradeRecord["lifecycle"]): number {
  if (lifecycle === "finalized") return 2;
  if (lifecycle === "finalizing") return 1;
  return 0;
}

export function upsertManagedTradeRecord(
  current: readonly ManagedTradeRecord[],
  record: ManagedTradeRecord,
): ManagedTradeRecord[] {
  const existing = current.find((item) => item.id === record.id);
  const preferred = existing && managedRecordLifecycleRank(existing.lifecycle) > managedRecordLifecycleRank(record.lifecycle)
    ? existing
    : existing?.lifecycle === record.lifecycle
      && existing.persistence === "browser"
      && record.persistence === "memory-only"
      ? existing
      : record;
  return [...current.filter((item) => item.id !== record.id), preferred];
}

export function removeManagedTradeRecord(
  current: readonly ManagedTradeRecord[],
  recordId: string,
): ManagedTradeRecord[] {
  return current.filter((item) => item.id !== recordId);
}
