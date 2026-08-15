export const TRADE_DRAFT_VERSION = 2;
export const TRADE_DRAFT_TTL_MS = 12 * 60 * 60 * 1_000;
export const TRADE_DRAFT_STORAGE_KEY = "bitcoin-p2p-check:trade-draft";
export const TRADE_DRAFT_MAX_RAW_LENGTH = 8 * 1_024;

const LEGACY_TRADE_DRAFT_VERSION = 1;
const TRADE_ROLES = new Set(["buyer", "seller"]);
const AMOUNT_BASES = new Set(["krw", "bitcoin"]);
const BITCOIN_DISPLAY_UNITS = new Set(["btc", "sats"]);
const TRANSFER_SUPPORT_OPTIONS = new Set(["onchain", "lightning", "both"]);
const FUNDING_SOURCES = new Set([
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
]);

const LEGACY_DRAFT_KEYS = [
  "version",
  "savedAt",
  "tradeRole",
  "krwAmounts",
  "bitcoinAmountInputs",
  "amountBasisByRole",
  "premiumInput",
  "fundingSources",
  "bitcoinDisplayUnit",
];
const DRAFT_KEYS = [...LEGACY_DRAFT_KEYS, "transferSupportByRole"];
const ROLE_KEYS = ["buyer", "seller"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function isKrwInput(value) {
  return typeof value === "string" && /^\d{0,15}$/.test(value);
}

function isBitcoinInput(value, displayUnit) {
  if (typeof value !== "string" || value.length > 24) return false;
  if (displayUnit === "sats") return /^\d{0,16}$/.test(value);
  return value === "" || /^\d+(?:\.\d*)?$/.test(value);
}

function isPremiumInput(value) {
  return typeof value === "string"
    && value.length <= 16
    && (value === "" || value === "-" || /^-?\d+(?:\.\d{0,2})?$/.test(value));
}

function removeInvalidDraft(storage) {
  try {
    storage?.removeItem?.(TRADE_DRAFT_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private browsing or under a restrictive policy.
  }
}

/**
 * Validates and returns a new allowlisted draft object.
 * Market data, timestamps from quotes, calculations, PNGs and share state are never accepted.
 */
export function validateTradeDraft(value, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now <= 0) return null;
  const isLegacyDraft = value?.version === LEGACY_TRADE_DRAFT_VERSION;
  if (!hasExactKeys(value, isLegacyDraft ? LEGACY_DRAFT_KEYS : DRAFT_KEYS)) return null;
  if (!isLegacyDraft && value.version !== TRADE_DRAFT_VERSION) return null;
  if (!Number.isSafeInteger(value.savedAt) || value.savedAt <= 0 || value.savedAt > now) return null;
  if (now - value.savedAt >= TRADE_DRAFT_TTL_MS) return null;
  if (!TRADE_ROLES.has(value.tradeRole)) return null;
  if (!BITCOIN_DISPLAY_UNITS.has(value.bitcoinDisplayUnit)) return null;
  if (!hasExactKeys(value.krwAmounts, ROLE_KEYS)
    || !ROLE_KEYS.every((role) => isKrwInput(value.krwAmounts[role]))) return null;
  if (!hasExactKeys(value.bitcoinAmountInputs, ROLE_KEYS)
    || !ROLE_KEYS.every((role) => isBitcoinInput(value.bitcoinAmountInputs[role], value.bitcoinDisplayUnit))) return null;
  if (!hasExactKeys(value.amountBasisByRole, ROLE_KEYS)
    || !ROLE_KEYS.every((role) => AMOUNT_BASES.has(value.amountBasisByRole[role]))) return null;
  if (!isPremiumInput(value.premiumInput)) return null;
  if (!hasExactKeys(value.fundingSources, ROLE_KEYS)
    || !ROLE_KEYS.every((role) => FUNDING_SOURCES.has(value.fundingSources[role]))) return null;
  if (!isLegacyDraft && (!hasExactKeys(value.transferSupportByRole, ROLE_KEYS)
    || !ROLE_KEYS.every((role) => TRANSFER_SUPPORT_OPTIONS.has(value.transferSupportByRole[role])))) return null;

  const transferSupportByRole = isLegacyDraft
    ? { buyer: "onchain", seller: "onchain" }
    : {
        buyer: value.transferSupportByRole.buyer,
        seller: value.transferSupportByRole.seller,
      };

  return {
    version: TRADE_DRAFT_VERSION,
    savedAt: value.savedAt,
    tradeRole: value.tradeRole,
    krwAmounts: { buyer: value.krwAmounts.buyer, seller: value.krwAmounts.seller },
    bitcoinAmountInputs: {
      buyer: value.bitcoinAmountInputs.buyer,
      seller: value.bitcoinAmountInputs.seller,
    },
    amountBasisByRole: {
      buyer: value.amountBasisByRole.buyer,
      seller: value.amountBasisByRole.seller,
    },
    premiumInput: value.premiumInput,
    fundingSources: {
      buyer: value.fundingSources.buyer,
      seller: value.fundingSources.seller,
    },
    bitcoinDisplayUnit: value.bitcoinDisplayUnit,
    transferSupportByRole,
  };
}

export function readTradeDraft(storage, now = Date.now()) {
  let raw;
  try {
    raw = storage?.getItem?.(TRADE_DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (typeof raw !== "string") return null;
  if (raw.length > TRADE_DRAFT_MAX_RAW_LENGTH) {
    removeInvalidDraft(storage);
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const draft = validateTradeDraft(parsed, now);
    if (draft) {
      if (parsed.version === LEGACY_TRADE_DRAFT_VERSION) {
        try {
          storage?.setItem?.(TRADE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
        } catch {
          // A readable draft remains usable even when storage cannot be updated.
        }
      }
      return draft;
    }
  } catch {
    // Malformed JSON is handled like every other invalid draft.
  }
  removeInvalidDraft(storage);
  return null;
}

export function writeTradeDraft(storage, fields, now = Date.now()) {
  const draft = validateTradeDraft({
    version: TRADE_DRAFT_VERSION,
    savedAt: now,
    tradeRole: fields?.tradeRole,
    krwAmounts: fields?.krwAmounts,
    bitcoinAmountInputs: fields?.bitcoinAmountInputs,
    amountBasisByRole: fields?.amountBasisByRole,
    premiumInput: fields?.premiumInput,
    fundingSources: fields?.fundingSources,
    bitcoinDisplayUnit: fields?.bitcoinDisplayUnit,
    transferSupportByRole: fields?.transferSupportByRole,
  }, now);
  if (!draft) return false;

  try {
    storage?.setItem?.(TRADE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    return typeof storage?.setItem === "function";
  } catch {
    return false;
  }
}
