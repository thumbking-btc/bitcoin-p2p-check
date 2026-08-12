import { MAX_SATS } from "./p2p-quote.mjs";

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

export function buildTradeFragment({ side, amount, premium, fundingSource, displayUnit = "sats" }) {
  if (side !== "buy" && side !== "sell") return "";
  if (displayUnit !== "btc" && displayUnit !== "sats") return "";
  const amountNumber = validAmount(String(amount), side === "buy" ? 15 : 16);
  if (amountNumber === null || (side === "sell" && amountNumber > MAX_SATS)) return "";
  const premiumNumber = validPremium(String(premium));
  const fundingCode = FUNDING_CODE_BY_SOURCE.get(fundingSource);
  if (premiumNumber === null || !fundingCode) return "";

  const params = new URLSearchParams();
  params.set("v", "1");
  params.set("side", side);
  params.set(side === "buy" ? "krw" : "sats", String(amountNumber));
  params.set("premium", String(premiumNumber));
  params.set("fund", fundingCode);
  params.set("unit", displayUnit);
  return `#${params.toString()}`;
}

export function parseTradeFragment(fragment) {
  if (typeof fragment !== "string" || fragment.length < 2 || fragment.length > MAX_FRAGMENT_LENGTH) return null;
  const params = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
  if (["v", "side", "premium"].some((key) => params.getAll(key).length !== 1)) return null;
  if (params.getAll("fund").length > 1) return null;
  if (params.getAll("unit").length > 1) return null;
  if (params.get("v") !== "1") return null;

  const side = params.get("side");
  if (side !== "buy" && side !== "sell") return null;
  if (params.getAll(side === "buy" ? "krw" : "sats").length !== 1) return null;
  if (side === "buy" && params.has("sats")) return null;
  if (side === "sell" && params.has("krw")) return null;

  const amount = validAmount(params.get(side === "buy" ? "krw" : "sats"), side === "buy" ? 15 : 16);
  if (amount === null || (side === "sell" && amount > MAX_SATS)) return null;
  const premium = validPremium(params.get("premium"));
  const fundingSource = FUNDING_SOURCE_BY_CODE.get(params.get("fund") ?? "none");
  const displayUnit = params.get("unit") ?? "sats";
  if (premium === null || !fundingSource || (displayUnit !== "btc" && displayUnit !== "sats")) return null;

  return { side, amount, premium, fundingSource, displayUnit };
}
