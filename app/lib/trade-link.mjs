import { MAX_KRW, MAX_PREMIUM_BPS, MAX_SATS, MIN_PREMIUM_BPS } from "./p2p-quote.mjs";

const MAX_FRAGMENT_LENGTH = 512;
const MAX_PREMIUM = 999.99;

const FUNDING_SOURCE_ENTRIES = [
  ["none", "기재하지 않음"],
  ["salary", "근로소득"],
  ["business", "사업소득"],
  ["pension", "연금소득"],
  ["financial", "금융소득"],
  ["rental", "임대소득"],
  ["asset-sale", "자산처분대금"],
  ["retirement", "퇴직금"],
  ["inheritance-gift", "상속·증여"],
  ["loan", "대출·차입금"],
  ["existing-funds", "기존 보유자금"],
  ["other", "기타소득"],
];

const FUNDING_SOURCE_BY_CODE = new Map(FUNDING_SOURCE_ENTRIES);
const FUNDING_CODE_BY_SOURCE = new Map(FUNDING_SOURCE_ENTRIES.map(([code, label]) => [label, code]));

function validAmount(value, maximumDigits) {
  if (!new RegExp(`^[1-9]\\d{0,${maximumDigits - 1}}$`).test(value ?? "")) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validPremium(value) {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value ?? "")) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= -100 || parsed > MAX_PREMIUM) return null;
  return parsed;
}

export function buildTradeFragment({ side, amount, premium, fundingSource, displayUnit = "sats", amountBasis }) {
  if (side !== "buy" && side !== "sell") return "";
  if (displayUnit !== "btc" && displayUnit !== "sats") return "";
  const basis = amountBasis ?? (side === "buy" ? "krw" : "bitcoin");
  if (basis !== "krw" && basis !== "bitcoin") return "";
  const amountNumber = validAmount(String(amount), basis === "krw" ? 15 : 16);
  if (amountNumber === null || (basis === "bitcoin" && amountNumber > MAX_SATS)) return "";
  const premiumNumber = validPremium(String(premium));
  const fundingCode = FUNDING_CODE_BY_SOURCE.get(fundingSource);
  if (premiumNumber === null || !fundingCode) return "";

  const browserShare = typeof window !== "undefined";
  const params = new URLSearchParams();
  params.set("v", browserShare ? "3" : "2");
  params.set(browserShare ? "from" : "side", side);
  params.set("basis", basis === "krw" ? "krw" : "btc");
  params.set(basis === "krw" ? "krw" : "sats", String(amountNumber));
  params.set("premium", String(premiumNumber));
  params.set("fund", fundingCode);
  params.set("unit", displayUnit);
  return `#${params.toString()}`;
}

/**
 * Copies only calculation inputs from a previously verified seller record.
 * The receiving calculator uses a fresh market price; this does not extend or
 * modify the signed record, or verify its signature or availability.
 */
export function buildBuyerContinuationFragment(condition) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) return "";
  if (condition.role !== "seller") return "";
  if (condition.amountBasis !== "krw" && condition.amountBasis !== "bitcoin") return "";
  if (condition.bitcoinDisplayUnit !== "btc" && condition.bitcoinDisplayUnit !== "sats") return "";
  if (!Number.isSafeInteger(condition.paymentKrw) || condition.paymentKrw <= 0 || condition.paymentKrw > MAX_KRW) return "";
  if (!Number.isSafeInteger(condition.sats) || condition.sats <= 0 || condition.sats > MAX_SATS) return "";
  if (!Number.isSafeInteger(condition.sellerPremiumBps)
    || condition.sellerPremiumBps < MIN_PREMIUM_BPS
    || condition.sellerPremiumBps > MAX_PREMIUM_BPS) return "";

  const isKrw = condition.amountBasis === "krw";
  const params = new URLSearchParams({
    v: "3",
    from: "sell",
    basis: isKrw ? "krw" : "btc",
    [isKrw ? "krw" : "sats"]: String(isKrw ? condition.paymentKrw : condition.sats),
    premium: String(condition.sellerPremiumBps / 100),
    fund: "none",
    unit: condition.bitcoinDisplayUnit,
    receive: "1",
  });
  return `#${params.toString()}`;
}

export function parseTradeFragment(fragment) {
  if (typeof fragment !== "string" || fragment.length < 2 || fragment.length > MAX_FRAGMENT_LENGTH) return null;
  const params = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
  const version = params.get("v");
  if (version !== "1" && version !== "2" && version !== "3") return null;

  const sideKey = version === "3" ? "from" : "side";
  if (["v", sideKey, "premium"].some((key) => params.getAll(key).length !== 1)) return null;
  if (version === "3" && params.has("side")) return null;
  if (version !== "3" && params.has("from")) return null;
  if (params.getAll("fund").length > 1) return null;
  if (params.getAll("unit").length > 1) return null;

  const creatorSide = params.get(sideKey);
  if (creatorSide !== "buy" && creatorSide !== "sell") return null;
  const continueToReceive = params.has("receive");
  if (continueToReceive && (params.getAll("receive").length !== 1
    || params.get("receive") !== "1"
    || version !== "3"
    || creatorSide !== "sell")) return null;
  const side = version === "3"
    ? creatorSide === "buy" ? "sell" : "buy"
    : creatorSide;

  let amountBasis;
  if (version === "1") {
    if (params.has("basis")) return null;
    amountBasis = creatorSide === "buy" ? "krw" : "bitcoin";
  } else {
    if (params.getAll("basis").length !== 1) return null;
    const basis = params.get("basis");
    if (basis !== "krw" && basis !== "btc") return null;
    amountBasis = basis === "krw" ? "krw" : "bitcoin";
  }

  const amountKey = amountBasis === "krw" ? "krw" : "sats";
  if (params.getAll(amountKey).length !== 1) return null;
  if (params.has(amountKey === "krw" ? "sats" : "krw")) return null;
  if (continueToReceive) {
    const allowedKeys = new Set(["v", "from", "basis", amountKey, "premium", "fund", "unit", "receive"]);
    if ([...params.keys()].some((key) => !allowedKeys.has(key))) return null;
    if (params.has("fund") && params.get("fund") !== "none") return null;
  }

  const amount = validAmount(params.get(amountKey), amountBasis === "krw" ? 15 : 16);
  if (amount === null || (amountBasis === "bitcoin" && amount > MAX_SATS)) return null;
  const premium = validPremium(params.get("premium"));
  const fundingSource = FUNDING_SOURCE_BY_CODE.get(params.get("fund") ?? "none");
  const displayUnit = params.get("unit") ?? "sats";
  if (premium === null || !fundingSource || (displayUnit !== "btc" && displayUnit !== "sats")) return null;

  const result = { side, amount, amountBasis, premium, fundingSource, displayUnit };
  if (continueToReceive) return { ...result, creatorSide, continueToReceive: true };
  return version === "3" ? { ...result, creatorSide } : result;
}
