import {
  canonicalTradeRecordBytes,
  canonicalizeSignedTradeRecord,
  canonicalizeTradeRecordApiSuccess,
  TRADE_RECORD_KEY_ID_PATTERN,
  type SignedTradeRecord,
  type TradeRecord,
} from "./trade-record.ts";

export type TradeRecordPublicJwk = JsonWebKey & Readonly<{ kid: string }>;

export const TRADE_RECORD_PUBLIC_KEYS: Readonly<Record<string, TradeRecordPublicJwk>> = Object.freeze({
  "p2p-trade-record-2026-08-25": Object.freeze({
    key_ops: ["verify"],
    ext: true,
    kty: "EC",
    x: "xst85hMO98R3X-9R7C5SyM6_wDcZuTxIM5upuEA_KLk",
    y: "x1qmac-Q5dcZg2yzAd50aUjTj8rAFn7Z_3JhZk9bUD4",
    crv: "P-256",
    kid: "p2p-trade-record-2026-08-25",
  }),
});

export type TradeRecordVerificationResult =
  | Readonly<{
    status: "valid";
    signed: SignedTradeRecord;
    record: TradeRecord;
    recordExpired: boolean;
    paymentExpired: boolean;
  }>
  | Readonly<{
    status: "invalid-record" | "unknown-key" | "invalid-signature" | "verification-unavailable";
    message: string;
  }>;

function signedFromUnknown(value: unknown): SignedTradeRecord {
  if (value && typeof value === "object" && !Array.isArray(value) && "ok" in value) {
    const api = canonicalizeTradeRecordApiSuccess(value);
    return Object.freeze({ record: api.record, signature: api.signature, keyId: api.keyId });
  }
  return canonicalizeSignedTradeRecord(value);
}

function decodeSignature(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/") + "==";
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 64) throw new TypeError("Invalid P-256 signature length.");
  return bytes;
}

function validPublicJwk(value: TradeRecordPublicJwk | undefined, keyId: string): value is TradeRecordPublicJwk {
  return Boolean(
    value
    && value.kty === "EC"
    && value.crv === "P-256"
    && typeof value.x === "string"
    && typeof value.y === "string"
    && value.kid === keyId
    && TRADE_RECORD_KEY_ID_PATTERN.test(keyId),
  );
}

export async function verifyTradeRecordSignature(
  value: unknown,
  options: Readonly<{
    nowMs?: number;
    publicKeys?: Readonly<Record<string, TradeRecordPublicJwk>>;
  }> = {},
): Promise<TradeRecordVerificationResult> {
  let signed: SignedTradeRecord;
  try {
    signed = signedFromUnknown(value);
  } catch {
    return { status: "invalid-record", message: "거래 기록의 형식과 내용을 확인하지 못했습니다." };
  }

  const publicKeys = options.publicKeys ?? TRADE_RECORD_PUBLIC_KEYS;
  const jwk = publicKeys[signed.keyId];
  if (!validPublicJwk(jwk, signed.keyId)) {
    return { status: "unknown-key", message: "이 기록에 사용된 공개키를 현재 앱에서 확인할 수 없습니다." };
  }

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = new Uint8Array(decodeSignature(signed.signature)).buffer;
    const data = new Uint8Array(canonicalTradeRecordBytes(signed.record)).buffer;
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      data,
    );
    if (!valid) return { status: "invalid-signature", message: "거래 기록이 서명 이후 변경되었거나 올바른 서명이 아닙니다." };

    const nowMs = options.nowMs ?? Date.now();
    const paymentExpired = signed.record.payment?.rail === "lightning" && signed.record.payment.expiresAt
      ? Date.parse(signed.record.payment.expiresAt) <= nowMs
      : false;
    return Object.freeze({
      status: "valid",
      signed,
      record: signed.record,
      recordExpired: Date.parse(signed.record.expiresAt) <= nowMs,
      paymentExpired,
    });
  } catch {
    return { status: "verification-unavailable", message: "이 기기에서 거래 기록 서명을 확인하지 못했습니다." };
  }
}
