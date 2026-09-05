import { calculateP2PQuote, MAX_SATS, roundedAppliedPriceKrw } from "./p2p-quote.mjs";

export const TRADE_RECORD_SCHEMA_V1 = "bitcoin-p2p-trade-record/v1" as const;
export const TRADE_RECORD_SCHEMA_V2 = "bitcoin-p2p-trade-record/v2" as const;

/** Current schema used by new records. Readers continue to accept v1. */
export const TRADE_RECORD_SCHEMA = TRADE_RECORD_SCHEMA_V2;

export const TRADE_RECORD_RETENTION_POLICIES = Object.freeze({
  [TRADE_RECORD_SCHEMA_V1]: Object.freeze({
    schema: TRADE_RECORD_SCHEMA_V1,
    retentionSeconds: 180 * 24 * 60 * 60,
  }),
  [TRADE_RECORD_SCHEMA_V2]: Object.freeze({
    schema: TRADE_RECORD_SCHEMA_V2,
    retentionSeconds: 14 * 24 * 60 * 60,
  }),
});

export type TradeRecordSchema = keyof typeof TRADE_RECORD_RETENTION_POLICIES;
export type TradeRecordRetentionPolicy = typeof TRADE_RECORD_RETENTION_POLICIES[TradeRecordSchema];

export function getTradeRecordRetentionPolicy(schema: TradeRecordSchema): TradeRecordRetentionPolicy;
export function getTradeRecordRetentionPolicy(schema: unknown): TradeRecordRetentionPolicy | null;
export function getTradeRecordRetentionPolicy(schema: unknown): TradeRecordRetentionPolicy | null {
  if (typeof schema !== "string" || !Object.hasOwn(TRADE_RECORD_RETENTION_POLICIES, schema)) return null;
  return TRADE_RECORD_RETENTION_POLICIES[schema as TradeRecordSchema];
}

/** @deprecated v1-only compatibility alias. Query the policy by schema for version-aware code. */
export const TRADE_RECORD_RETENTION_SECONDS = TRADE_RECORD_RETENTION_POLICIES[TRADE_RECORD_SCHEMA_V1].retentionSeconds;
export const TRADE_RECORD_MAX_CANONICAL_BYTES = 6_144;
export const TRADE_RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
export const TRADE_RECORD_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
export const TRADE_RECORD_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
export const TRADE_RECORD_REVOKE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const MAX_KRW = 999_999_999_999_999;
const MAX_PREMIUM_BPS = 99_999;
const MAX_REFERENCE_AGE_MS = 5 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;

export const TRADE_RECORD_FUNDING_SOURCES = Object.freeze([
  "기재하지 않음",
  "근로소득",
  "사업소득",
  "연금소득",
  "금융소득",
  "임대소득",
  "자산처분대금",
  "퇴직금",
  "상속·증여",
  "대출·차입금",
  "기존 보유자금",
  "기타소득",
] as const);

export type TradeRecordRole = "buyer" | "seller";
export type TradeRecordAmountBasis = "krw" | "bitcoin";
export type TradeRecordBitcoinDisplayUnit = "btc" | "sats";
export type TradeRecordFundingSource = typeof TRADE_RECORD_FUNDING_SOURCES[number];

export type TradeRecordCondition = Readonly<{
  role: TradeRecordRole;
  amountBasis: TradeRecordAmountBasis;
  bitcoinDisplayUnit: TradeRecordBitcoinDisplayUnit;
  paymentKrw: number;
  sats: number;
  referencePriceKrw: number;
  marketObservedAt: string;
  koreaPremiumRatio: number | null;
  sellerPremiumBps: number;
  fundingSource: TradeRecordFundingSource | null;
}>;

export type TradeRecordPaymentDraft =
  | Readonly<{ rail: "onchain"; payload: string; address: string }>
  | Readonly<{ rail: "lightning"; payload: string; address?: string }>;

export type TradeRecordPayment =
  | Readonly<{ rail: "onchain"; payload: string; address: string }>
  | Readonly<{ rail: "lightning"; payload: string; address: string; expiresAt?: never }>
  | Readonly<{ rail: "lightning"; payload: string; expiresAt: string; address?: never }>;

export type TradeRecordDraft = Readonly<{
  condition: TradeRecordCondition;
  payment: TradeRecordPaymentDraft | null;
}>;

export type TradeRecord = Readonly<{
  schema: TradeRecordSchema;
  id: string;
  createdAt: string;
  expiresAt: string;
  condition: TradeRecordCondition;
  payment: TradeRecordPayment | null;
}>;

export type SignedTradeRecord = Readonly<{
  record: TradeRecord;
  signature: string;
  keyId: string;
}>;

export type TradeRecordApiSuccess = SignedTradeRecord & Readonly<{
  ok: true;
  id: string;
  verificationUrl: string;
  lifecycle?: "pending" | "finalized";
  revokeToken?: string;
}>;

export type TradeRecordRevokeSuccess = Readonly<{
  ok: true;
  id: string;
  lifecycle: "revoked";
}>;

export type TradeRecordApiError = Readonly<{
  ok: false;
  code: string;
  message: string;
}>;

export type TradeRecordApiResponse = TradeRecordApiSuccess | TradeRecordRevokeSuccess | TradeRecordApiError;

export class TradeRecordValidationError extends TypeError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TradeRecordValidationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new TradeRecordValidationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeInteger(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("INVALID_CONDITION", `${field} 값의 범위를 확인하지 못했습니다.`);
  }
  return Number(value);
}

function canonicalIso(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 20 || value.length > 32) {
    fail("INVALID_TIMESTAMP", `${field} 시각을 확인하지 못했습니다.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("INVALID_TIMESTAMP", `${field} 시각을 확인하지 못했습니다.`);
  return new Date(milliseconds).toISOString();
}

function boundedString(value: unknown, maximumLength: number, field: string): string {
  const hasControlCharacter = typeof value === "string" && Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  if (typeof value !== "string" || !value || value.length > maximumLength || hasControlCharacter) {
    fail("INVALID_PAYMENT", `${field} 값을 확인하지 못했습니다.`);
  }
  return value;
}

export function isTradeRecordId(value: unknown): value is string {
  return typeof value === "string" && TRADE_RECORD_ID_PATTERN.test(value);
}

export function deriveAppliedPriceKrw(condition: Pick<TradeRecordCondition, "referencePriceKrw" | "sellerPremiumBps">): string {
  const rounded = roundedAppliedPriceKrw(condition.referencePriceKrw, condition.sellerPremiumBps);
  if (rounded === null) throw new RangeError("The applied KRW price is outside the supported range.");
  return rounded;
}

export function canonicalizeTradeRecordCondition(value: unknown): TradeRecordCondition {
  const keys = [
    "role",
    "amountBasis",
    "bitcoinDisplayUnit",
    "paymentKrw",
    "sats",
    "referencePriceKrw",
    "marketObservedAt",
    "koreaPremiumRatio",
    "sellerPremiumBps",
    "fundingSource",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    fail("INVALID_CONDITION", "거래 조건 항목을 확인하지 못했습니다.");
  }

  if (value.role !== "buyer" && value.role !== "seller") fail("INVALID_CONDITION", "거래 역할을 확인하지 못했습니다.");
  if (value.amountBasis !== "krw" && value.amountBasis !== "bitcoin") fail("INVALID_CONDITION", "금액 기준을 확인하지 못했습니다.");
  if (value.bitcoinDisplayUnit !== "btc" && value.bitcoinDisplayUnit !== "sats") fail("INVALID_CONDITION", "비트코인 표시 단위를 확인하지 못했습니다.");

  const paymentKrw = safeInteger(value.paymentKrw, 1, MAX_KRW, "원화 금액");
  const sats = safeInteger(value.sats, 1, MAX_SATS, "비트코인 수량");
  const referencePriceKrw = safeInteger(value.referencePriceKrw, 1, MAX_KRW, "기준 시세");
  const sellerPremiumBps = safeInteger(value.sellerPremiumBps, -9_999, MAX_PREMIUM_BPS, "판매자 프리미엄");
  const marketObservedAt = canonicalIso(value.marketObservedAt, "시세 관측");

  let koreaPremiumRatio: number | null = null;
  if (value.koreaPremiumRatio !== null) {
    if (typeof value.koreaPremiumRatio !== "number" || !Number.isFinite(value.koreaPremiumRatio) || Math.abs(value.koreaPremiumRatio) > 0.5) {
      fail("INVALID_CONDITION", "업비트 프리미엄 참고값을 확인하지 못했습니다.");
    }
    koreaPremiumRatio = Object.is(value.koreaPremiumRatio, -0) ? 0 : value.koreaPremiumRatio;
  }

  let fundingSource: TradeRecordFundingSource | null = null;
  if (value.fundingSource !== null) {
    if (typeof value.fundingSource !== "string" || !(TRADE_RECORD_FUNDING_SOURCES as readonly string[]).includes(value.fundingSource)) {
      fail("INVALID_CONDITION", "구매자 자금 출처를 확인하지 못했습니다.");
    }
    fundingSource = value.fundingSource as TradeRecordFundingSource;
  }

  const premiumPercent = sellerPremiumBps / 100;
  const quote = calculateP2PQuote({
    mode: value.amountBasis === "krw" ? "krw" : "sats",
    amount: value.amountBasis === "krw" ? paymentKrw : sats,
    referencePrice: referencePriceKrw,
    premiumPercent,
  });
  if (!quote || quote.paymentKrw !== paymentKrw || quote.sats !== sats) {
    fail("INCONSISTENT_CONDITION", "원화 금액과 비트코인 수량이 기준가·프리미엄 계산과 일치하지 않습니다.");
  }

  return Object.freeze({
    role: value.role,
    amountBasis: value.amountBasis,
    bitcoinDisplayUnit: value.bitcoinDisplayUnit,
    paymentKrw,
    sats,
    referencePriceKrw,
    marketObservedAt,
    koreaPremiumRatio,
    sellerPremiumBps,
    fundingSource,
  });
}

export function assertFreshTradeRecordReference(condition: TradeRecordCondition, createdAtMs: number): void {
  const observedAtMs = Date.parse(condition.marketObservedAt);
  const ageMs = createdAtMs - observedAtMs;
  if (ageMs > MAX_REFERENCE_AGE_MS || ageMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
    fail("STALE_REFERENCE", "최근 시세로 계산한 거래 조건만 기록할 수 있습니다.");
  }
}

function canonicalizeStoredPayment(value: unknown): TradeRecordPayment | null {
  if (value === null) return null;
  if (!isRecord(value) || (value.rail !== "onchain" && value.rail !== "lightning")) {
    fail("INVALID_PAYMENT", "BTC 수취정보를 확인하지 못했습니다.");
  }
  if (value.rail === "onchain") {
    if (!hasExactKeys(value, ["rail", "payload", "address"])) fail("INVALID_PAYMENT", "온체인 수취정보 항목을 확인하지 못했습니다.");
    return Object.freeze({
      rail: "onchain",
      payload: boundedString(value.payload, 300, "BIP21"),
      address: boundedString(value.address, 128, "비트코인 주소"),
    });
  }
  if (hasExactKeys(value, ["rail", "payload", "address"])) {
    const address = boundedString(value.address, 254, "라이트닝 주소");
    if (boundedString(value.payload, 254, "라이트닝 주소") !== address) fail("INVALID_PAYMENT", "라이트닝 주소 항목이 일치하지 않습니다.");
    return Object.freeze({ rail: "lightning", payload: address, address });
  }
  if (!hasExactKeys(value, ["rail", "payload", "expiresAt"])) fail("INVALID_PAYMENT", "라이트닝 수취정보 항목을 확인하지 못했습니다.");
  return Object.freeze({
    rail: "lightning",
    payload: boundedString(value.payload, 1_200, "BOLT11"),
    expiresAt: canonicalIso(value.expiresAt, "라이트닝 인보이스 만료"),
  });
}

function canonicalizeTradeRecordVersion(value: Record<string, unknown>, schema: TradeRecordSchema): TradeRecord {
  if (!hasExactKeys(value, ["schema", "id", "createdAt", "expiresAt", "condition", "payment"])) {
    fail("INVALID_RECORD", "거래 기록 항목을 확인하지 못했습니다.");
  }
  if (value.schema !== schema || !isTradeRecordId(value.id)) fail("INVALID_RECORD", "거래 기록 버전 또는 식별자를 확인하지 못했습니다.");

  const createdAt = canonicalIso(value.createdAt, "기록 생성");
  const expiresAt = canonicalIso(value.expiresAt, "기록 보관 만료");
  const createdAtMs = Date.parse(createdAt);
  const retentionPolicy = getTradeRecordRetentionPolicy(schema);
  if (Date.parse(expiresAt) !== createdAtMs + retentionPolicy.retentionSeconds * 1_000) {
    fail("INVALID_RECORD", "거래 기록 보관 기간을 확인하지 못했습니다.");
  }

  const condition = canonicalizeTradeRecordCondition(value.condition);
  const payment = canonicalizeStoredPayment(value.payment);
  if (payment?.rail === "lightning" && payment.expiresAt && Date.parse(payment.expiresAt) <= createdAtMs) {
    fail("INVALID_PAYMENT", "생성 시점에 이미 만료된 라이트닝 인보이스입니다.");
  }

  return Object.freeze({
    schema,
    id: value.id,
    createdAt,
    expiresAt,
    condition,
    payment,
  });
}

export function canonicalizeTradeRecord(value: unknown): TradeRecord {
  if (!isRecord(value)) fail("INVALID_RECORD", "거래 기록 항목을 확인하지 못했습니다.");

  switch (value.schema) {
    case TRADE_RECORD_SCHEMA_V1:
      return canonicalizeTradeRecordVersion(value, TRADE_RECORD_SCHEMA_V1);
    case TRADE_RECORD_SCHEMA_V2:
      return canonicalizeTradeRecordVersion(value, TRADE_RECORD_SCHEMA_V2);
    default:
      fail("INVALID_RECORD", "거래 기록 버전 또는 식별자를 확인하지 못했습니다.");
  }
}

export function canonicalTradeRecordJson(value: unknown): string {
  const json = JSON.stringify(canonicalizeTradeRecord(value));
  if (new TextEncoder().encode(json).byteLength > TRADE_RECORD_MAX_CANONICAL_BYTES) {
    fail("INVALID_RECORD", "거래 기록이 너무 큽니다.");
  }
  return json;
}

export function canonicalTradeRecordBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalTradeRecordJson(value));
}

export function canonicalizeSignedTradeRecord(value: unknown): SignedTradeRecord {
  if (!isRecord(value) || !hasExactKeys(value, ["record", "signature", "keyId"])) {
    fail("INVALID_ENVELOPE", "서명된 거래 기록 항목을 확인하지 못했습니다.");
  }
  if (typeof value.signature !== "string" || !TRADE_RECORD_SIGNATURE_PATTERN.test(value.signature)) {
    fail("INVALID_ENVELOPE", "거래 기록 서명 형식을 확인하지 못했습니다.");
  }
  if (typeof value.keyId !== "string" || !TRADE_RECORD_KEY_ID_PATTERN.test(value.keyId)) {
    fail("INVALID_ENVELOPE", "거래 기록 서명 키를 확인하지 못했습니다.");
  }
  return Object.freeze({
    record: canonicalizeTradeRecord(value.record),
    signature: value.signature,
    keyId: value.keyId,
  });
}

export function canonicalizeTradeRecordApiSuccess(value: unknown): TradeRecordApiSuccess {
  const baseKeys = ["ok", "record", "signature", "keyId", "id", "verificationUrl"] as const;
  const managedKeys = [...baseKeys, "lifecycle", "revokeToken"] as const;
  const managed = isRecord(value) && hasExactKeys(value, managedKeys);
  if (!isRecord(value) || (!hasExactKeys(value, baseKeys) && !managed) || value.ok !== true) {
    fail("INVALID_RESPONSE", "거래 기록 서버 응답을 확인하지 못했습니다.");
  }
  const signed = canonicalizeSignedTradeRecord({ record: value.record, signature: value.signature, keyId: value.keyId });
  if (value.id !== signed.record.id || typeof value.verificationUrl !== "string" || value.verificationUrl.length > 512) {
    fail("INVALID_RESPONSE", "거래 기록 검증 링크를 확인하지 못했습니다.");
  }
  let verificationUrl: URL;
  try {
    verificationUrl = new URL(value.verificationUrl);
  } catch {
    fail("INVALID_RESPONSE", "거래 기록 검증 링크를 확인하지 못했습니다.");
  }
  const localHttp = verificationUrl.protocol === "http:" && (verificationUrl.hostname === "localhost" || verificationUrl.hostname === "127.0.0.1");
  if (verificationUrl.protocol !== "https:" && !localHttp) {
    fail("INVALID_RESPONSE", "HTTPS 검증 링크만 사용할 수 있습니다.");
  }
  if (verificationUrl.pathname !== "/verify/" || verificationUrl.searchParams.getAll("id").length !== 1 || verificationUrl.searchParams.get("id") !== signed.record.id || verificationUrl.hash) {
    fail("INVALID_RESPONSE", "거래 기록 검증 링크를 확인하지 못했습니다.");
  }
  if (
    managed
    && (
      (value.lifecycle !== "pending" && value.lifecycle !== "finalized")
      || typeof value.revokeToken !== "string"
      || !TRADE_RECORD_REVOKE_TOKEN_PATTERN.test(value.revokeToken)
    )
  ) {
    fail("INVALID_RESPONSE", "거래 기록 관리 capability를 확인하지 못했습니다.");
  }
  return Object.freeze({
    ok: true,
    record: signed.record,
    signature: signed.signature,
    keyId: signed.keyId,
    id: signed.record.id,
    verificationUrl: verificationUrl.toString(),
    ...(managed ? { lifecycle: value.lifecycle as "pending" | "finalized", revokeToken: value.revokeToken as string } : {}),
  });
}

export function canonicalizeTradeRecordRevokeSuccess(value: unknown): TradeRecordRevokeSuccess {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["ok", "id", "lifecycle"])
    || value.ok !== true
    || !isTradeRecordId(value.id)
    || value.lifecycle !== "revoked"
  ) {
    fail("INVALID_RESPONSE", "거래 기록 폐기 응답을 확인하지 못했습니다.");
  }
  return Object.freeze({ ok: true, id: value.id, lifecycle: "revoked" });
}
