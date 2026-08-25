import {
  canonicalizeSignedTradeRecord,
  getTradeRecordRetentionPolicy,
  isTradeRecordId,
  type SignedTradeRecord,
} from "../app/lib/trade-record.ts";
import { fail } from "./trade-record-http.ts";

const RECORD_KEY_PREFIX = "trade-record:v1:";
const MANAGEMENT_KEY_PREFIX = "trade-record:v1:manage:";
const REVOKE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const PENDING_RECORD_TTL_SECONDS = 15 * 60;
export const MIN_LIGHTNING_PAYMENT_REMAINING_SECONDS = 120;

export type RecordLifecycle = "pending" | "finalized";
export type StoredRecordLifecycle = RecordLifecycle | "revoked";

export type StoredManagedRecord = Readonly<{
  version: 1;
  lifecycle: StoredRecordLifecycle;
  tokenHash: string;
  signed: SignedTradeRecord;
}>;

export type ManagementIndex = Readonly<{
  version: 1;
  id: string;
  state: "revoked";
}>;

export type ParsedStoredRecord = Readonly<{
  signed: SignedTradeRecord;
  lifecycle: StoredRecordLifecycle;
  tokenHash: string | null;
}>;

type TradeRecordFeatureEnvironment = Readonly<{
  DEPLOYMENT_ENV?: string;
  TRADE_RECORDS_ENABLED?: string | boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function storageKey(id: string): string {
  return `${RECORD_KEY_PREFIX}${id}`;
}

export function managementKey(tokenHash: string): string {
  return `${MANAGEMENT_KEY_PREFIX}${tokenHash}`;
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

export function parseCreateLifecycle(request: Request): RecordLifecycle {
  const value = request.headers.get("X-Trade-Record-Lifecycle");
  if (value === "pending") return "pending";
  if (value === null) {
    fail("CLIENT_UPGRADE_REQUIRED", "거래 기록을 비공개 준비 상태로 만들 수 있는 최신 앱에서 다시 시도하십시오.");
  }
  fail("INVALID_LIFECYCLE", "거래 기록 공개 상태를 확인하지 못했습니다.");
}

export function createRevokeToken(request: Request): string {
  const supplied = request.headers.get("Idempotency-Key");
  if (supplied === null) {
    fail("IDEMPOTENCY_KEY_REQUIRED", "거래 기록 준비에는 철회 가능한 멱등성 capability가 필요합니다.");
  }
  if (!REVOKE_TOKEN_PATTERN.test(supplied)) {
    fail("INVALID_IDEMPOTENCY_KEY", "멱등성 키는 256비트 base64url capability여야 합니다.");
  }
  return supplied;
}

export function authorizationToken(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(request.headers.get("Authorization") ?? "");
  if (!match || !REVOKE_TOKEN_PATTERN.test(match[1])) {
    fail("INVALID_CAPABILITY", "거래 기록 관리 권한을 확인하지 못했습니다.", 401, { "WWW-Authenticate": "Bearer" });
  }
  return match[1];
}

export function parseManagementIndex(value: string | null): ManagementIndex | null {
  if (value === null || new TextEncoder().encode(value).byteLength > 512) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed)
      || !hasExactKeys(parsed, ["version", "id", "state"])
      || parsed.version !== 1
      || !isTradeRecordId(parsed.id)
      || parsed.state !== "revoked"
    ) {
      return null;
    }
    return { version: 1, id: parsed.id, state: "revoked" };
  } catch {
    return null;
  }
}

export function parseStoredRecord(value: string): ParsedStoredRecord {
  if (new TextEncoder().encode(value).byteLength > 8_192) {
    fail("STORAGE_CORRUPT", "저장된 거래 기록을 확인하지 못했습니다.", 500);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("STORAGE_CORRUPT", "저장된 거래 기록을 확인하지 못했습니다.", 500);
  }

  if (
    isRecord(parsed)
    && hasExactKeys(parsed, ["version", "lifecycle", "tokenHash", "signed"])
    && parsed.version === 1
    && (parsed.lifecycle === "pending" || parsed.lifecycle === "finalized" || parsed.lifecycle === "revoked")
    && typeof parsed.tokenHash === "string"
    && TOKEN_HASH_PATTERN.test(parsed.tokenHash)
  ) {
    try {
      return {
        signed: canonicalizeSignedTradeRecord(parsed.signed),
        lifecycle: parsed.lifecycle,
        tokenHash: parsed.tokenHash,
      };
    } catch {
      fail("STORAGE_CORRUPT", "저장된 거래 기록을 확인하지 못했습니다.", 500);
    }
  }

  try {
    return { signed: canonicalizeSignedTradeRecord(parsed), lifecycle: "finalized", tokenHash: null };
  } catch {
    fail("STORAGE_CORRUPT", "저장된 거래 기록을 확인하지 못했습니다.", 500);
  }
}

export function storedManagedRecord(
  signed: SignedTradeRecord,
  lifecycle: StoredRecordLifecycle,
  tokenHash: string,
): StoredManagedRecord {
  return Object.freeze({ version: 1, lifecycle, tokenHash, signed });
}

export function recordTtl(signed: SignedTradeRecord, nowMs: number): number {
  const remaining = Math.ceil((Date.parse(signed.record.expiresAt) - nowMs) / 1_000);
  if (remaining <= 0) fail("RECORD_EXPIRED", "거래 기록 보관 기간이 끝났습니다.", 404);
  const retentionPolicy = getTradeRecordRetentionPolicy(signed.record.schema);
  return Math.min(retentionPolicy.retentionSeconds, remaining);
}

export function assertTradeRecordPaymentFinalizable(
  signed: SignedTradeRecord,
  nowMs: number,
): void {
  const payment = signed.record.payment;
  if (payment?.rail !== "lightning" || payment.address) return;
  if (typeof payment.expiresAt !== "string") {
    fail("PAYMENT_EXPIRING", "라이트닝 인보이스 만료 시각을 확인하지 못했습니다.", 409);
  }
  const expiresAtMs = Date.parse(payment.expiresAt);
  if (!Number.isFinite(expiresAtMs)
    || !Number.isFinite(nowMs)
    || expiresAtMs - nowMs < MIN_LIGHTNING_PAYMENT_REMAINING_SECONDS * 1_000) {
    fail(
      "PAYMENT_EXPIRING",
      "라이트닝 인보이스가 만료되었거나 2분 안에 만료됩니다. 새 인보이스로 거래 기록을 다시 준비하십시오.",
      409,
    );
  }
}

export function recordsExplicitlyDisabled(environment: TradeRecordFeatureEnvironment): boolean {
  const deployment = environment.DEPLOYMENT_ENV?.trim().toLowerCase();
  const enabled = typeof environment.TRADE_RECORDS_ENABLED === "boolean"
    ? String(environment.TRADE_RECORDS_ENABLED)
    : environment.TRADE_RECORDS_ENABLED?.trim().toLowerCase();
  return deployment !== "production" || enabled !== "true";
}
