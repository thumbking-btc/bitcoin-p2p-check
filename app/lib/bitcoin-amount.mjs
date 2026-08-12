import { MAX_SATS, SATS_PER_BTC } from "./p2p-quote.mjs";

/**
 * @param {string} value
 * @param {"btc" | "sats"} unit
 * @returns {{ sats: number | null; error: "format" | "precision" | "range" | null }}
 */
export function parseBitcoinAmount(value, unit) {
  const raw = String(value ?? "").replaceAll(",", "").trim();
  if (!raw) return { sats: null, error: null };
  if (raw.length > 24) return { sats: null, error: "range" };

  let sats;
  if (unit === "sats") {
    if (!/^\d+$/.test(raw)) return { sats: null, error: "format" };
    sats = BigInt(raw);
  } else if (unit === "btc") {
    if (!/^\d*(?:\.\d*)?$/.test(raw) || raw === ".") {
      return { sats: null, error: "format" };
    }
    const [wholePart = "0", fractionPart = ""] = raw.split(".");
    if (fractionPart.length > 8) return { sats: null, error: "precision" };
    const whole = BigInt(wholePart || "0");
    const fraction = BigInt(fractionPart.padEnd(8, "0") || "0");
    sats = whole * BigInt(SATS_PER_BTC) + fraction;
  } else {
    return { sats: null, error: "format" };
  }

  if (sats > BigInt(MAX_SATS)) return { sats: null, error: "range" };
  return { sats: Number(sats), error: null };
}

/** @param {number | bigint} sats */
export function satsToBtcInput(sats) {
  const value = BigInt(sats);
  const whole = value / BigInt(SATS_PER_BTC);
  const fraction = (value % BigInt(SATS_PER_BTC)).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Keeps a decimal input editable without silently discarding precision.
 * @param {string} value
 */
export function normalizeBtcInput(value) {
  const raw = String(value ?? "").replaceAll(",", "").trim();
  if (!/^\d*(?:\.\d*)?$/.test(raw)) return null;
  if (raw.length > 24) return null;
  if (raw === ".") return "0.";
  return raw.startsWith(".") ? `0${raw}` : raw;
}

/**
 * Adds grouping to the BTC whole-number part while preserving every decimal.
 * @param {string} value
 */
export function groupedBtcInput(value) {
  const raw = String(value ?? "");
  if (!raw) return raw;
  const [whole = "", fraction] = raw.split(".");
  const groupedWhole = (whole || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? groupedWhole : `${groupedWhole}.${fraction}`;
}
