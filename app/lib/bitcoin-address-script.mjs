import { bech32, bech32m, createBase58check, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const BASE58CHECK = createBase58check(sha256);
const MAX_ADDRESS_LENGTH = 90;

export class BitcoinAddressError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "BitcoinAddressError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BitcoinAddressError(code, message);
}

function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function canLiftXOnlyPublicKey(program) {
  try {
    secp256k1.Point.fromBytes(concatBytes(Uint8Array.of(0x02), program));
    return true;
  } catch {
    return false;
  }
}

function knownResult(canonicalAddress, scriptType, scriptPubKeyHex) {
  return Object.freeze({ canonicalAddress, scriptType, scriptPubKeyHex });
}

function decodeBase58Address(address) {
  let payload;
  try {
    payload = BASE58CHECK.decode(address);
  } catch {
    return null;
  }

  if (payload.length !== 21) {
    fail("ADDRESS_FORMAT", "Base58Check 주소 길이가 올바르지 않습니다.");
  }

  const version = payload[0];
  if (version !== 0x00 && version !== 0x05) {
    fail("ADDRESS_NETWORK", "비트코인 메인넷 주소만 지원합니다.");
  }

  const canonicalAddress = BASE58CHECK.encode(payload);
  if (canonicalAddress !== address) {
    fail("ADDRESS_NONCANONICAL", "정규화된 메인넷 주소만 지원합니다.");
  }

  const program = hex.encode(payload.slice(1));
  if (version === 0x00) {
    return knownResult(canonicalAddress, "p2pkh", "76a914" + program + "88ac");
  }
  return knownResult(canonicalAddress, "p2sh", "a914" + program + "87");
}

function decodeSegwitAddress(address) {
  if (!address.toLowerCase().startsWith("bc1")) {
    fail("ADDRESS_NETWORK", "비트코인 메인넷 주소만 지원합니다.");
  }
  const lowercaseAddress = address.toLowerCase();
  const uppercaseAddress = address.toUpperCase();
  if (address !== lowercaseAddress && address !== uppercaseAddress) {
    fail("ADDRESS_NONCANONICAL", "SegWit 주소는 대문자나 소문자 한 가지로만 입력하세요.");
  }

  let decoded;
  let codec;
  try {
    decoded = bech32.decode(address);
    codec = bech32;
  } catch {
    try {
      decoded = bech32m.decode(address);
      codec = bech32m;
    } catch {
      fail("ADDRESS_CHECKSUM", "주소 형식 또는 체크섬이 올바르지 않습니다.");
    }
  }

  if (decoded.prefix !== "bc" || decoded.words.length < 2) {
    fail("ADDRESS_NETWORK", "비트코인 메인넷 주소만 지원합니다.");
  }

  const version = decoded.words[0];
  if (version !== 0 && version !== 1) {
    fail("WITNESS_VERSION", "알려진 메인넷 주소 유형만 지원합니다.");
  }

  let program;
  try {
    program = bech32.fromWords(decoded.words.slice(1));
  } catch {
    fail("WITNESS_PADDING", "주소의 witness program이 올바르지 않습니다.");
  }

  let scriptType;
  if (version === 0) {
    if (codec !== bech32 || (program.length !== 20 && program.length !== 32)) {
      fail("WITNESS_PROGRAM", "SegWit v0 주소가 올바르지 않습니다.");
    }
    scriptType = program.length === 20 ? "p2wpkh" : "p2wsh";
  } else {
    if (codec !== bech32m || program.length !== 32 || !canLiftXOnlyPublicKey(program)) {
      fail("WITNESS_PROGRAM", "Taproot 주소가 올바르지 않습니다.");
    }
    scriptType = "p2tr";
  }

  const canonicalAddress = codec.encode("bc", decoded.words).toLowerCase();
  if (canonicalAddress !== lowercaseAddress) {
    fail("ADDRESS_NONCANONICAL", "정규화된 메인넷 주소만 지원합니다.");
  }

  const versionOpcode = version === 0 ? "00" : "51";
  const pushLength = program.length.toString(16).padStart(2, "0");
  return knownResult(
    canonicalAddress,
    scriptType,
    versionOpcode + pushLength + hex.encode(program),
  );
}

/**
 * Converts one canonical, known mainnet address into its exact scriptPubKey.
 * P2PKH, P2SH, P2WPKH, P2WSH, and liftable P2TR are accepted.
 */
export function decodeKnownMainnetAddress(address) {
  if (
    typeof address !== "string"
    || address.length === 0
    || address.length > MAX_ADDRESS_LENGTH
    || /\s/u.test(address)
  ) {
    fail("ADDRESS_FORMAT", "비트코인 주소 형식이 올바르지 않습니다.");
  }

  const base58 = decodeBase58Address(address);
  if (base58) return base58;
  return decodeSegwitAddress(address);
}
