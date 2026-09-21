import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const MAX_BOLT11_LENGTH = 1_200;
export const DEFAULT_BOLT11_EXPIRY_SECONDS = 3_600;

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const MAX_SATS = 2_100_000_000_000_000n;
const KNOWN_REQUIRED_INVOICE_FEATURES = new Set([8, 14, 16, 24, 36, 48]);

export class Bolt11InvoiceError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "Bolt11InvoiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new Bolt11InvoiceError(code, message);
}

function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function wordsToBytesPadded(words) {
  let accumulator = 0;
  let bits = 0;
  const output = [];
  for (const word of words) {
    if (!Number.isInteger(word) || word < 0 || word > 31) fail("FORMAT", "인보이스 데이터 형식을 확인하지 못했습니다.");
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      output.push((accumulator >> bits) & 0xff);
    }
    accumulator &= bits === 0 ? 0 : (1 << bits) - 1;
  }
  if (bits > 0) output.push((accumulator << (8 - bits)) & 0xff);
  return Uint8Array.from(output);
}

function wordsToBytesStrict(words) {
  try {
    return bech32.fromWords(words);
  } catch {
    fail("FORMAT", "인보이스 필드의 비트 패딩을 확인하지 못했습니다.");
  }
}

function wordsToBigInt(words, fieldName) {
  if (words.length > 11 || (words.length > 1 && words[0] === 0)) {
    fail("FORMAT", `${fieldName} 필드가 최소 형식이 아닙니다.`);
  }
  let value = 0n;
  for (const word of words) value = (value << 5n) | BigInt(word);
  return value;
}

function parseAmountMsat(prefix) {
  if (!prefix.startsWith("lnbc")) fail("NETWORK", "비트코인 메인넷 lnbc 인보이스만 사용할 수 있습니다.");
  const encoded = prefix.slice(4);
  if (!encoded) fail("AMOUNT_REQUIRED", "정확한 금액이 들어 있는 라이트닝 인보이스를 만드세요.");
  const match = /^(\d+)([munp]?)$/u.exec(encoded);
  if (!match || match[1].startsWith("0")) fail("AMOUNT_FORMAT", "라이트닝 인보이스 금액 형식을 확인하지 못했습니다.");
  const value = BigInt(match[1]);
  if (value <= 0n) fail("AMOUNT_RANGE", "라이트닝 인보이스 금액은 1 sat 이상이어야 합니다.");
  const multiplier = match[2];
  if (multiplier === "p") {
    if (value % 10n !== 0n) fail("AMOUNT_SUB_MSAT", "밀리사토시보다 작은 금액의 인보이스는 사용할 수 없습니다.");
    return value / 10n;
  }
  if (multiplier === "n") return value * 100n;
  if (multiplier === "u") return value * 100_000n;
  if (multiplier === "m") return value * 100_000_000n;
  return value * 100_000_000_000n;
}

function setFeatureBits(words) {
  const bits = new Set();
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];
    for (let bit = 0; bit < 5; bit += 1) {
      if ((word & (1 << bit)) !== 0) bits.add((words.length - 1 - index) * 5 + bit);
    }
  }
  for (const bit of bits) {
    if (bit % 2 === 0 && !KNOWN_REQUIRED_INVOICE_FEATURES.has(bit)) {
      fail("FEATURE_REQUIRED", `지원하지 않는 필수 라이트닝 기능 비트 ${bit}가 있습니다.`);
    }
  }
  return [...bits].sort((left, right) => left - right);
}

function parseTaggedFields(words) {
  const fields = new Map();
  let cursor = 7;
  while (cursor < words.length) {
    if (cursor + 3 > words.length) fail("FORMAT", "라이트닝 인보이스 태그가 잘렸습니다.");
    const type = CHARSET[words[cursor]];
    const length = words[cursor + 1] * 32 + words[cursor + 2];
    cursor += 3;
    if (!type || cursor + length > words.length) fail("FORMAT", "라이트닝 인보이스 태그 길이를 확인하지 못했습니다.");
    const data = words.slice(cursor, cursor + length);
    cursor += length;
    const entries = fields.get(type) ?? [];
    entries.push(data);
    fields.set(type, entries);
  }
  return fields;
}

function exactlyOne(fields, type, expectedLength, message) {
  const entries = fields.get(type) ?? [];
  if (entries.length !== 1 || (expectedLength !== null && entries[0].length !== expectedLength)) fail("TAG_REQUIRED", message);
  return entries[0];
}

function constantTimeEqual(left, right) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function validateDescription(fields, expectedDescriptionHash) {
  const descriptions = fields.get("d") ?? [];
  const hashes = fields.get("h") ?? [];
  if ((descriptions.length === 1) === (hashes.length === 1)) {
    fail("DESCRIPTION", "라이트닝 인보이스에는 설명 또는 설명 해시 하나만 있어야 합니다.");
  }
  if (descriptions.length > 1 || hashes.length > 1 || (hashes[0] && hashes[0].length !== 52)) {
    fail("DESCRIPTION", "라이트닝 인보이스 설명 필드를 확인하지 못했습니다.");
  }
  const descriptionHash = hashes[0] ? wordsToBytesStrict(hashes[0]) : null;
  if (descriptionHash && descriptionHash.length !== 32) {
    fail("DESCRIPTION", "라이트닝 인보이스 설명 해시를 확인하지 못했습니다.");
  }
  if (descriptions[0]) {
    const bytes = wordsToBytesStrict(descriptions[0]);
    if (bytes.length > 639) fail("DESCRIPTION", "라이트닝 인보이스 설명이 너무 깁니다.");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("DESCRIPTION", "라이트닝 인보이스 설명의 UTF-8 형식을 확인하지 못했습니다.");
    }
  }
  if (expectedDescriptionHash !== undefined) {
    // Current LUD-06 permits a normal d-only invoice. When a provider elects
    // to use BOLT11 h, bind it to the exact LNURL metadata preimage we have.
    if (descriptionHash && !constantTimeEqual(descriptionHash, expectedDescriptionHash)) {
      fail("DESCRIPTION_HASH_MISMATCH", "LNURL-pay 인보이스와 metadata가 일치하지 않습니다.");
    }
  }
}

function verifySignature(prefix, signedWords, signatureWords, payeeWords) {
  const encodedSignature = wordsToBytesStrict(signatureWords);
  if (encodedSignature.length !== 65 || encodedSignature[64] > 3) fail("SIGNATURE", "라이트닝 인보이스 서명을 확인하지 못했습니다.");
  const signature = encodedSignature.slice(0, 64);
  const recovery = encodedSignature[64];
  const digest = sha256(concatBytes(new TextEncoder().encode(prefix), wordsToBytesPadded(signedWords)));

  if (payeeWords) {
    const payee = wordsToBytesStrict(payeeWords);
    if (payee.length !== 33 || !secp256k1.verify(signature, digest, payee, { prehash: false, lowS: true })) {
      fail("SIGNATURE", "라이트닝 인보이스 서명과 수취 노드가 일치하지 않습니다.");
    }
    return payee;
  }

  try {
    const recovered = secp256k1.recoverPublicKey(concatBytes(Uint8Array.of(recovery), signature), digest, { prehash: false });
    if (!secp256k1.verify(signature, digest, recovered, { prehash: false, lowS: false })) throw new Error("verify");
    return recovered;
  } catch {
    fail("SIGNATURE", "라이트닝 인보이스 서명을 확인하지 못했습니다.");
  }
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Strictly validates one exact-amount Bitcoin-mainnet BOLT11 invoice.
 * The invoice stays in the caller's memory; this function performs no I/O.
 */
export function validateBolt11Invoice(input, options = {}) {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_BOLT11_LENGTH) {
    fail("INPUT_LENGTH", "라이트닝 인보이스 길이를 확인해 주세요.");
  }
  if (typeof options.expectedSats !== "bigint" || options.expectedSats < 1n || options.expectedSats > MAX_SATS) {
    fail("EXPECTED_AMOUNT", "거래의 정확한 사토시를 확인하지 못했습니다.");
  }
  if (
    options.expectedDescriptionHash !== undefined
    && (!(options.expectedDescriptionHash instanceof Uint8Array) || options.expectedDescriptionHash.length !== 32)
  ) {
    fail("EXPECTED_DESCRIPTION_HASH", "예상한 인보이스 설명 해시를 확인하지 못했습니다.");
  }
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const minimumRemainingSeconds = options.minimumRemainingSeconds ?? 60;
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0 || !Number.isSafeInteger(minimumRemainingSeconds) || minimumRemainingSeconds < 0) {
    fail("CLOCK", "인보이스 확인 시각을 확인하지 못했습니다.");
  }

  let invoice = input;
  if (/^lightning:/iu.test(invoice)) invoice = invoice.slice("lightning:".length);
  if (!invoice || invoice.includes(":") || invoice !== invoice.trim()) fail("INPUT_FORMAT", "BOLT11 인보이스 한 개만 공백 없이 붙여넣으세요.");
  if (invoice !== invoice.toLowerCase() && invoice !== invoice.toUpperCase()) fail("INPUT_FORMAT", "대소문자가 섞인 라이트닝 인보이스는 사용할 수 없습니다.");
  invoice = invoice.toLowerCase();

  let decoded;
  try {
    decoded = bech32.decode(invoice, false);
  } catch {
    fail("CHECKSUM", "라이트닝 인보이스 체크섬을 확인하지 못했습니다.");
  }
  const prefix = decoded.prefix;
  const amountMsat = parseAmountMsat(prefix);
  const expectedMsat = options.expectedSats * 1_000n;
  if (amountMsat % 1_000n !== 0n) fail("AMOUNT_SUB_SAT", "정수 사토시가 아닌 라이트닝 인보이스는 사용할 수 없습니다.");
  if (amountMsat !== expectedMsat) fail("AMOUNT_MISMATCH", "인보이스 금액이 고정한 거래 금액과 정확히 일치하지 않습니다.");

  const words = decoded.words;
  if (words.length < 7 + 104) fail("FORMAT", "라이트닝 인보이스 데이터가 너무 짧습니다.");
  const signedWords = words.slice(0, -104);
  const signatureWords = words.slice(-104);
  if (signedWords.length < 7) fail("FORMAT", "라이트닝 인보이스 시각을 확인하지 못했습니다.");
  const timestampBig = wordsToBigInt(signedWords.slice(0, 7), "생성 시각");
  if (timestampBig > BigInt(Number.MAX_SAFE_INTEGER)) fail("TIMESTAMP", "라이트닝 인보이스 생성 시각을 확인하지 못했습니다.");
  const timestamp = Number(timestampBig);
  if (timestamp > nowSeconds + 300) fail("TIMESTAMP", "현재보다 지나치게 미래인 라이트닝 인보이스는 사용할 수 없습니다.");

  const fields = parseTaggedFields(signedWords);
  const paymentHashWords = exactlyOne(fields, "p", 52, "결제 해시 하나가 있는 인보이스만 사용할 수 있습니다.");
  const paymentSecretWords = exactlyOne(fields, "s", 52, "결제 비밀값 하나가 있는 최신 라이트닝 인보이스만 사용할 수 있습니다.");
  wordsToBytesStrict(paymentSecretWords);
  validateDescription(fields, options.expectedDescriptionHash);
  if ((fields.get("f") ?? []).length > 0) fail("FALLBACK", "온체인 fallback이 포함된 인보이스는 별도 방식 거래에서 사용할 수 없습니다.");
  if ((fields.get("n") ?? []).length > 1 || ((fields.get("n") ?? [])[0]?.length ?? 53) !== 53) fail("PAYEE", "수취 노드 필드를 확인하지 못했습니다.");
  if ((fields.get("x") ?? []).length > 1 || (fields.get("9") ?? []).length > 1) fail("TAG_DUPLICATE", "중복된 인보이스 필드를 사용할 수 없습니다.");

  const expiryWords = (fields.get("x") ?? [])[0];
  const expiryBig = expiryWords ? wordsToBigInt(expiryWords, "만료") : BigInt(DEFAULT_BOLT11_EXPIRY_SECONDS);
  if (expiryBig > BigInt(Number.MAX_SAFE_INTEGER)) fail("EXPIRY", "라이트닝 인보이스 만료 시간을 확인하지 못했습니다.");
  const expirySeconds = Number(expiryBig);
  const expiresAt = timestamp + expirySeconds;
  const remainingSeconds = expiresAt - nowSeconds;
  if (!Number.isSafeInteger(expiresAt) || remainingSeconds <= 0 || remainingSeconds < minimumRemainingSeconds) {
    fail("EXPIRED", "만료되었거나 곧 만료되는 인보이스입니다. 지갑에서 새 인보이스를 만드세요.");
  }

  const featureWords = (fields.get("9") ?? [])[0] ?? [];
  if (featureWords.length > 1 && featureWords[0] === 0) fail("FEATURE_FORMAT", "라이트닝 기능 필드가 최소 형식이 아닙니다.");
  const featureBits = setFeatureBits(featureWords);
  if ((featureBits.includes(16) || featureBits.includes(17)) && (fields.get("s") ?? []).length !== 1) {
    fail("FEATURE_DEPENDENCY", "MPP 기능에 필요한 payment_secret이 없습니다.");
  }
  const payeeWords = (fields.get("n") ?? [])[0];
  const payeeNodeId = verifySignature(prefix, signedWords, signatureWords, payeeWords);
  const paymentHash = wordsToBytesStrict(paymentHashWords);

  return Object.freeze({
    amountMsat,
    canonicalInvoice: invoice,
    expiresAt,
    expirySeconds,
    featureBits: Object.freeze(featureBits),
    payeeNodeId: bytesToHex(payeeNodeId),
    paymentHash: bytesToHex(paymentHash),
    timestamp,
  });
}
