import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const PRIVATE_KEY = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1,
]);

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function wordsToBytesPadded(words) {
  let accumulator = 0;
  let bits = 0;
  const output = [];
  for (const word of words) {
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

function integerWords(value, minimumLength = 1) {
  let remaining = BigInt(value);
  const words = [];
  do {
    words.unshift(Number(remaining & 31n));
    remaining >>= 5n;
  } while (remaining > 0n);
  while (words.length < minimumLength) words.unshift(0);
  return words;
}

function tagged(type, words) {
  const typeWord = CHARSET.indexOf(type);
  if (typeWord < 0 || words.length > 1_023) throw new RangeError("Invalid BOLT11 fixture tag.");
  return [typeWord, words.length >> 5, words.length & 31, ...words];
}

export function createBolt11Invoice({
  amountSats,
  timestampSeconds = Math.floor(Date.now() / 1_000),
  expirySeconds = 3_600,
  network = "bc",
  description = "Bitcoin P2P test invoice",
  descriptionHash,
  duplicateDescriptionHash = false,
} = {}) {
  if (!Number.isSafeInteger(amountSats) || amountSats < 1) throw new RangeError("amountSats is required.");
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 1) throw new RangeError("timestampSeconds is invalid.");
  if (!Number.isSafeInteger(expirySeconds) || expirySeconds < 1) throw new RangeError("expirySeconds is invalid.");
  if (!/^(?:bc|tb)$/u.test(network)) throw new RangeError("network is invalid.");
  if (descriptionHash !== undefined && (!(descriptionHash instanceof Uint8Array) || descriptionHash.length !== 32)) {
    throw new RangeError("descriptionHash must be 32 bytes.");
  }
  if (descriptionHash === undefined && (typeof description !== "string" || description.length === 0)) {
    throw new RangeError("description is invalid.");
  }
  if (duplicateDescriptionHash && descriptionHash === undefined) {
    throw new RangeError("duplicateDescriptionHash requires descriptionHash.");
  }

  const prefix = `ln${network}${BigInt(amountSats) * 10_000n}p`;
  const paymentHash = new Uint8Array(32).fill(0x11);
  const paymentSecret = new Uint8Array(32).fill(0x22);
  const descriptionFields = descriptionHash === undefined
    ? tagged("d", bech32.toWords(new TextEncoder().encode(description)))
    : [
        ...tagged("h", bech32.toWords(descriptionHash)),
        ...(duplicateDescriptionHash ? tagged("h", bech32.toWords(descriptionHash)) : []),
      ];
  const signedWords = [
    ...integerWords(timestampSeconds, 7),
    ...tagged("p", bech32.toWords(paymentHash)),
    ...tagged("s", bech32.toWords(paymentSecret)),
    ...descriptionFields,
    ...tagged("x", integerWords(expirySeconds)),
  ];
  const digest = sha256(concatBytes(
    new TextEncoder().encode(prefix),
    wordsToBytesPadded(signedWords),
  ));
  const recoveredSignature = secp256k1.sign(digest, PRIVATE_KEY, {
    format: "recovered",
    lowS: true,
    prehash: false,
  });
  const signature = concatBytes(recoveredSignature.slice(1), recoveredSignature.slice(0, 1));
  return bech32.encode(prefix, [...signedWords, ...bech32.toWords(signature)], 2_000);
}
