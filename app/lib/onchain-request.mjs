import { decodeKnownMainnetAddress } from "./bitcoin-address-script.mjs";

const SATS_PER_BTC = 100_000_000n;
export const MAX_ONCHAIN_REQUEST_SATS = 2_100_000_000_000_000n;

export class OnchainRequestError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "OnchainRequestError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OnchainRequestError(code, message);
}

export function formatSatsAsBtcAmount(sats) {
  if (typeof sats !== "bigint" || sats < 1n || sats > MAX_ONCHAIN_REQUEST_SATS) {
    fail("AMOUNT_RANGE", "받을 금액은 1 sat 이상 비트코인 최대 공급량 이하여야 합니다.");
  }
  const whole = sats / SATS_PER_BTC;
  const remainder = sats % SATS_PER_BTC;
  if (remainder === 0n) return whole.toString();
  return `${whole}.${remainder.toString().padStart(8, "0").replace(/0+$/u, "")}`;
}

function hasForbiddenAddressCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f || ":?#[]\\".includes(character);
  });
}

export function createOnchainRequest(addressInput, sats) {
  if (
    typeof addressInput !== "string"
    || addressInput.length === 0
    || addressInput !== addressInput.trim()
    || hasForbiddenAddressCharacter(addressInput)
  ) {
    fail("ADDRESS_FORMAT", "bitcoin: URI가 아닌 메인넷 수취 주소 한 개를 공백 없이 입력하십시오.");
  }

  let decoded;
  try {
    decoded = decodeKnownMainnetAddress(addressInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : "비트코인 메인넷 수취 주소를 확인하지 못했습니다.";
    fail("ADDRESS_INVALID", message);
  }

  const btcAmount = formatSatsAsBtcAmount(sats);
  const uri = `bitcoin:${decoded.canonicalAddress}?amount=${btcAmount}`;
  return Object.freeze({
    address: decoded.canonicalAddress,
    btcAmount,
    sats: sats.toString(),
    scriptType: decoded.scriptType,
    uri,
  });
}
