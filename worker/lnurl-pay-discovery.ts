import { validateBolt11Invoice } from "../app/lib/bolt11-invoice.mjs";
import { sha256 } from "@noble/hashes/sha2.js";

const MAX_LNURL_METADATA_BYTES = 256_000;

const PAYER_DATA_LABELS: Record<string, string> = {
  name: "이름",
  pubkey: "공개키",
  identifier: "라이트닝 주소",
  email: "이메일",
  auth: "인증정보",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function lnurlPayMetadataHash(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) return null;

  const rawBytes = new TextEncoder().encode(value);
  if (rawBytes.length === 0 || rawBytes.length > MAX_LNURL_METADATA_BYTES) return null;

  let metadata: unknown;
  try {
    metadata = JSON.parse(value);
  } catch {
    return null;
  }

  if (!Array.isArray(metadata) || metadata.length === 0) return null;
  let descriptionCount = 0;
  for (const entry of metadata) {
    if (
      !Array.isArray(entry)
      || entry.length < 2
      || typeof entry[0] !== "string"
      || entry[0].length === 0
    ) {
      return null;
    }
    // LUD-06 requires only the entry type to be a string and explicitly
    // reserves arbitrary JSON/trailing values for forward-compatible entries.
    // The mandatory text/plain entry still needs a usable description value.
    if (entry[0] === "text/plain") {
      if (typeof entry[1] !== "string" || entry[1].trim().length === 0) return null;
      descriptionCount += 1;
    }
  }
  return descriptionCount === 1 ? sha256(rawBytes) : null;
}

export function mandatoryPayerDataLabels(discovery: Record<string, unknown>): string[] {
  if (!isRecord(discovery.payerData)) return [];
  return Object.entries(discovery.payerData)
    .filter(([, config]) => isRecord(config) && config.mandatory === true)
    .map(([key]) => PAYER_DATA_LABELS[key] ?? key)
    .slice(0, 8);
}

export function canonicalLnurlPayInvoice(
  value: unknown,
  amountSats: number,
  expectedDescriptionHash: Uint8Array,
): string | null {
  if (
    typeof value !== "string"
    || !Number.isSafeInteger(amountSats)
    || amountSats < 1
    || !(expectedDescriptionHash instanceof Uint8Array)
    || expectedDescriptionHash.length !== 32
  ) return null;
  try {
    return validateBolt11Invoice(value, {
      expectedDescriptionHash,
      expectedSats: BigInt(amountSats),
      minimumRemainingSeconds: 120,
    }).canonicalInvoice;
  } catch {
    return null;
  }
}
