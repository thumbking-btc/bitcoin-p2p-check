import { binarize, Byte, Decoder, Detector, Encoder, grayscale } from "@nuintun/qrcode";

import { decodeKnownMainnetAddress } from "./bitcoin-address-script.mjs";

export const MAX_P2P_RECEIVE_SATS = 2_100_000_000_000_000n;

const SATS_PER_BTC = 100_000_000n;
const BASE58_PRIVATE_KEY = /^(?:5[1-9A-HJ-NP-Za-km-z]{50}|[KL][1-9A-HJ-NP-Za-km-z]{51})$/;
const EXTENDED_PRIVATE_KEY = /^(?:xprv|tprv|yprv|zprv|Yprv|Zprv|uprv|vprv|Uprv|Vprv)[1-9A-HJ-NP-Za-km-z]{90,120}$/;
const EXTENDED_PRIVATE_KEY_TOKEN = /(?:xprv|tprv|yprv|zprv|Yprv|Zprv|uprv|vprv|Uprv|Vprv)[1-9A-HJ-NP-Za-km-z]{16,}/;
const WIF_PRIVATE_KEY_TOKEN = /(?:^|[^1-9A-HJ-NP-Za-km-z])(?:5[1-9A-HJ-NP-Za-km-z]{50}|[KL][1-9A-HJ-NP-Za-km-z]{51})(?:$|[^1-9A-HJ-NP-Za-km-z])/;
const BIP38_PRIVATE_KEY = /^6P[1-9A-HJ-NP-Za-km-z]{56}$/;
const CASASCIUS_MINI_KEY = /^S[1-9A-HJ-NP-Za-km-z]{21,29}$/;
const HEX_PRIVATE_KEY = /^[0-9a-f]{64}$/i;
const SEEDQR_NUMERIC = /^[0-9]{48,96}$/;
const UR_SECRET_MATERIAL = /^ur:crypto-(?:seed|hdkey)\//i;
const RECOVERY_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);
const MAX_ADDRESS_INPUT_LENGTH = 90;
const PLAUSIBLE_BASE58_ADDRESS_INPUT = /^[13][1-9A-HJ-NP-Za-km-z]{0,34}$/;
const PLAUSIBLE_BECH32_ADDRESS_INPUT = /^(?:b|bc|bc1[023456789acdefghjklmnpqrstuvwxyz]{0,87})$/i;
const RESERVED_ADDRESS_CHARACTERS = new Set([":", "?", "#", "[", "]", "\\"]);
const REQUEST_KEYS = Object.freeze([
  "address",
  "addressConfirmed",
  "amountConfirmed",
  "sats",
]);
const REQUEST_RESULT_KEYS = Object.freeze([
  "address",
  "btcAmount",
  "sats",
  "scriptType",
  "uri",
]);

export class P2PReceiveRequestError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "P2PReceiveRequestError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new P2PReceiveRequestError(code, message);
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function hasForbiddenAddressCharacter(address) {
  for (const character of address) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined
      || codePoint <= 0x20
      || codePoint === 0x7f
      || RESERVED_ADDRESS_CHARACTERS.has(character)
    ) {
      return true;
    }
  }
  return false;
}

function looksLikeSecretMaterial(value) {
  const candidate = value.trim();
  if (
    BASE58_PRIVATE_KEY.test(candidate)
    || WIF_PRIVATE_KEY_TOKEN.test(candidate)
    || EXTENDED_PRIVATE_KEY.test(candidate)
    || EXTENDED_PRIVATE_KEY_TOKEN.test(candidate)
    || BIP38_PRIVATE_KEY.test(candidate)
    || CASASCIUS_MINI_KEY.test(candidate)
    || HEX_PRIVATE_KEY.test(candidate)
    || SEEDQR_NUMERIC.test(candidate)
    || UR_SECRET_MATERIAL.test(candidate)
  ) {
    return true;
  }
  const words = candidate.split(/\s+/u);
  return RECOVERY_WORD_COUNTS.has(words.length)
    && words.every((word) => /^[\p{L}\p{M}]{1,32}$/u.test(word));
}

function isPlausibleMainnetAddressInput(value) {
  return value.length === 0
    || PLAUSIBLE_BASE58_ADDRESS_INPUT.test(value)
    || PLAUSIBLE_BECH32_ADDRESS_INPUT.test(value);
}

export function assertP2PReceiveAddressInputSafe(value) {
  if (
    typeof value === "string"
    && (
      value.length > MAX_ADDRESS_INPUT_LENGTH
      || !isPlausibleMainnetAddressInput(value)
      || looksLikeSecretMaterial(value)
    )
  ) {
    fail("ADDRESS_UNSAFE", "주소가 아닌 값이나 비밀정보처럼 보이는 입력을 지웠습니다. 복구문구·개인키·xprv는 넣지 마세요.");
  }
  return value;
}

export function formatSatsAsBtcAmount(sats) {
  if (typeof sats !== "bigint" || sats < 1n || sats > MAX_P2P_RECEIVE_SATS) {
    fail("AMOUNT_RANGE", "수취 금액은 1 sat 이상 비트코인 최대 공급량 이하여야 합니다.");
  }
  const whole = sats / SATS_PER_BTC;
  const remainder = sats % SATS_PER_BTC;
  if (remainder === 0n) return whole.toString();
  return whole.toString() + "." + remainder.toString().padStart(8, "0").replace(/0+$/, "");
}

/**
 * Builds one minimal amount-only BIP 321 request. The address authority is
 * always asserted by the buyer; it is never inferred from a role or share URL.
 */
export function createP2PReceiveRequest(input) {
  if (!hasExactKeys(input, REQUEST_KEYS)) {
    fail("INPUT_SCHEMA", "수취 요청 입력 형식을 확인하지 못했습니다.");
  }
  if (input.addressConfirmed !== true) {
    fail("ADDRESS_CONFIRMATION", "지갑 화면에서 전체 주소를 먼저 직접 확인하세요.");
  }
  if (input.amountConfirmed !== true) {
    fail("AMOUNT_CONFIRMATION", "정확한 사토시와 별도 채굴 수수료를 먼저 확인하세요.");
  }
  assertP2PReceiveAddressInputSafe(input.address);
  if (
    typeof input.address !== "string"
    || input.address.length === 0
    || input.address !== input.address.trim()
    || hasForbiddenAddressCharacter(input.address)
  ) {
    fail("ADDRESS_BARE_ONLY", "bitcoin: URI가 아닌 메인넷 주소 한 개를 공백 없이 입력하세요.");
  }
  if (typeof input.sats !== "bigint") {
    fail("AMOUNT_TYPE", "수취 금액을 정확한 사토시 정수로 확인하지 못했습니다.");
  }

  let decoded;
  try {
    decoded = decodeKnownMainnetAddress(input.address);
  } catch {
    fail("ADDRESS_UNSUPPORTED", "확인 가능한 비트코인 메인넷 수취 주소 한 개를 입력하세요.");
  }

  const btcAmount = formatSatsAsBtcAmount(input.sats);
  const uri = "bitcoin:" + decoded.canonicalAddress + "?amount=" + btcAmount;
  return Object.freeze({
    address: decoded.canonicalAddress,
    btcAmount,
    sats: input.sats.toString(),
    scriptType: decoded.scriptType,
    uri,
  });
}

function validateRequestResult(request) {
  if (!hasExactKeys(request, REQUEST_RESULT_KEYS)) {
    fail("QR_PAYLOAD", "결제 요청 QR의 내용을 확인하지 못했습니다.");
  }
  if (
    typeof request.address !== "string"
    || typeof request.btcAmount !== "string"
    || typeof request.sats !== "string"
    || typeof request.scriptType !== "string"
    || typeof request.uri !== "string"
    || !/^[1-9][0-9]*$/u.test(request.sats)
  ) {
    fail("QR_PAYLOAD", "결제 요청 QR의 내용을 확인하지 못했습니다.");
  }

  let sats;
  let decoded;
  try {
    sats = BigInt(request.sats);
    decoded = decodeKnownMainnetAddress(request.address);
  } catch {
    fail("QR_PAYLOAD", "결제 요청 QR의 내용을 확인하지 못했습니다.");
  }
  const btcAmount = formatSatsAsBtcAmount(sats);
  const uri = "bitcoin:" + decoded.canonicalAddress + "?amount=" + btcAmount;
  if (
    request.address !== decoded.canonicalAddress
    || request.scriptType !== decoded.scriptType
    || request.btcAmount !== btcAmount
    || request.uri !== uri
  ) {
    fail("QR_PAYLOAD", "결제 요청 QR의 주소와 금액이 일치하지 않습니다.");
  }
  return uri;
}

function renderQrRaster(encoded, moduleSize = 8, quietZoneModules = 4) {
  const moduleCount = encoded.size;
  const pixelSize = (moduleCount + quietZoneModules * 2) * moduleSize;
  const data = new Uint8ClampedArray(pixelSize * pixelSize * 4);
  data.fill(255);

  for (let moduleY = 0; moduleY < moduleCount; moduleY += 1) {
    for (let moduleX = 0; moduleX < moduleCount; moduleX += 1) {
      if (encoded.get(moduleX, moduleY) !== 1) continue;
      const startX = (moduleX + quietZoneModules) * moduleSize;
      const startY = (moduleY + quietZoneModules) * moduleSize;
      for (let y = startY; y < startY + moduleSize; y += 1) {
        for (let x = startX; x < startX + moduleSize; x += 1) {
          const offset = (y * pixelSize + x) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
          data[offset + 3] = 255;
        }
      }
    }
  }
  return { data, height: pixelSize, width: pixelSize };
}

function decodeQrRaster(image) {
  const luminances = grayscale(image);
  const detected = new Detector().detect(binarize(luminances, image.width, image.height));
  const decoder = new Decoder();
  const symbols = [];
  let current = detected.next();
  let attempts = 0;

  while (!current.done && attempts < 16) {
    attempts += 1;
    let succeeded = false;
    try {
      symbols.push(decoder.decode(current.value.matrix).content);
      succeeded = true;
    } catch {
      // Detector candidates can be finder-like shapes rather than QR symbols.
    }
    current = detected.next(succeeded);
  }
  if (!current.done) fail("QR_VERIFY", "생성한 QR을 제한 안에서 다시 확인하지 못했습니다.");
  return symbols;
}

/**
 * Renders the request locally and decodes the resulting pixels before return.
 * A missing, duplicate, or byte-different symbol fails closed.
 */
export function createVerifiedP2PReceiveQr(request, options = {}) {
  const verifiedUri = validateRequestResult(request);

  let encoded;
  try {
    encoded = new Encoder({ level: "M" }).encode(new Byte(verifiedUri));
  } catch {
    fail("QR_ENCODE", "결제 요청 QR을 만들지 못했습니다.");
  }

  const raster = renderQrRaster(encoded);
  const decodeSymbols = options.decodeSymbols ?? decodeQrRaster;
  let symbols;
  try {
    symbols = decodeSymbols(raster);
  } catch (error) {
    raster.data.fill(0);
    if (error instanceof P2PReceiveRequestError) throw error;
    fail("QR_VERIFY", "생성한 QR의 주소와 금액을 다시 읽지 못했습니다.");
  }
  if (!Array.isArray(symbols) || symbols.length !== 1 || symbols[0] !== verifiedUri) {
    raster.data.fill(0);
    fail("QR_VERIFY", "생성한 QR의 주소와 금액이 원문과 일치하지 않습니다.");
  }
  return {
    data: raster.data,
    height: raster.height,
    payload: verifiedUri,
    width: raster.width,
  };
}
