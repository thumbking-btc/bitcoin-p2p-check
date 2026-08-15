import assert from "node:assert/strict";
import test from "node:test";

import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  Bolt11InvoiceError,
  DEFAULT_BOLT11_EXPIRY_SECONDS,
  MAX_BOLT11_LENGTH,
  validateBolt11Invoice,
} from "../app/lib/bolt11-invoice.mjs";

// Official BOLT 11 vectors:
// https://github.com/lightning/bolts/blob/master/11-payment-encoding.md#examples
const OFFICIAL_COFFEE = "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
const OFFICIAL_DONATION_WITHOUT_AMOUNT = "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";
const OFFICIAL_TESTNET_FALLBACK = "lntb20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfpp3x9et2e20v6pu37c5d9vax37wxq72un989qrsgqdj545axuxtnfemtpwkc45hx9d2ft7x04mt8q7y6t0k2dge9e7h8kpy9p34ytyslj3yu569aalz2xdk8xkd7ltxqld94u8h2esmsmacgpghe9k8";
const OFFICIAL_MAINNET_FALLBACK = "lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfppqw508d6qejxtdg4y5r3zarvary0c5xw7k9qrsgqt29a0wturnys2hhxpner2e3plp6jyj8qx7548zr2z7ptgjjc7hljm98xhjym0dg52sdrvqamxdezkmqg4gdrvwwnf0kv2jdfnl4xatsqmrnsse";

const OFFICIAL_INVALID = Object.freeze([
  [
    "FEATURE_REQUIRED",
    2_500_000n,
    "lnbc25m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5vdhkven9v5sxyetpdeessp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9q4psqqqqqqqqqqqqqqqqsgqtqyx5vggfcsll4wu246hz02kp85x4katwsk9639we5n5yngc3yhqkm35jnjw4len8vrnqnf5ejh0mzj9n3vz2px97evektfm2l6wqccp3y7372",
  ],
  [
    "CHECKSUM",
    250_000n,
    "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpuyk0sg5g70me25alkluzd2x62aysf2pyy8edtjeevuv4p2d5p76r4zkmneet7uvyakky2zr4cusd45tftc9c5fh0nnqpnl2jfll544esqchsrnt",
  ],
  [
    "SIGNATURE",
    250_000n,
    "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgqwgt7mcn5yqw3yx0w94pswkpq6j9uh6xfqqqtsk4tnarugeektd4hg5975x9am52rz4qskukxdmjemg92vvqz8nvmsye63r5ykel43pgz7zq0g2",
  ],
  [
    "AMOUNT_REQUIRED",
    1n,
    "lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6na6hlh",
  ],
  [
    "AMOUNT_FORMAT",
    250_000n,
    "lnbc2500x1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgqrrzc4cvfue4zp3hggxp47ag7xnrlr8vgcmkjxk3j5jqethnumgkpqp23z9jclu3v0a7e0aruz366e9wqdykw6dxhdzcjjhldxq0w6wgqcnu43j",
  ],
  [
    "AMOUNT_SUB_MSAT",
    1n,
    "lnbc2500000001p1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgq0lzc236j96a95uv0m3umg28gclm5lqxtqqwk32uuk4k6673k6n5kfvx3d2h8s295fad45fdhmusm8sjudfhlf6dcsxmfvkeywmjdkxcp99202x",
  ],
  [
    "TAG_REQUIRED",
    2_000_000n,
    "lnbc20m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp49qdkj",
  ],
]);

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const PRIVATE_KEY = Uint8Array.from(Buffer.from("e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734", "hex"));
const PUBLIC_KEY = secp256k1.getPublicKey(PRIVATE_KEY, true);
const CURVE_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const FIXED_TIMESTAMP = 2_000_000_000;

function assertCode(code) {
  return (error) => error instanceof Bolt11InvoiceError && error.code === code;
}

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
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

function fixedWidthWords(value, length) {
  const words = new Array(length).fill(0);
  let remaining = BigInt(value);
  for (let index = length - 1; index >= 0; index -= 1) {
    words[index] = Number(remaining & 31n);
    remaining >>= 5n;
  }
  assert.equal(remaining, 0n);
  return words;
}

function minimalWords(value) {
  let remaining = BigInt(value);
  if (remaining === 0n) return [];
  const words = [];
  while (remaining > 0n) {
    words.unshift(Number(remaining & 31n));
    remaining >>= 5n;
  }
  return words;
}

function tagged(type, words) {
  const typeWord = CHARSET.indexOf(type);
  assert.notEqual(typeWord, -1);
  assert.ok(words.length <= 1_023);
  return [typeWord, words.length >> 5, words.length & 31, ...words];
}

function featureWords(bits) {
  if (bits.length === 0) return [];
  const words = new Array(Math.floor(Math.max(...bits) / 5) + 1).fill(0);
  for (const bit of bits) words[words.length - 1 - Math.floor(bit / 5)] |= 1 << (bit % 5);
  return words;
}

function unsignedFields({ descriptionHash, expiry = 600, featureBits = [], paymentHash, paymentSecret } = {}) {
  const hash = paymentHash ?? Uint8Array.from({ length: 32 }, (_, index) => index);
  const secret = paymentSecret ?? new Uint8Array(32).fill(0x11);
  return [
    tagged("p", bech32.toWords(hash)),
    tagged("s", bech32.toWords(secret)),
    descriptionHash
      ? tagged("h", bech32.toWords(descriptionHash))
      : tagged("d", bech32.toWords(new TextEncoder().encode("exact trade"))),
    ...(expiry === null ? [] : [tagged("x", minimalWords(expiry))]),
    ...(featureBits.length === 0 ? [] : [tagged("9", featureWords(featureBits))]),
  ];
}

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value, length) {
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  assert.equal(remaining, 0n);
  return bytes;
}

function makeInvoice({
  fields = unsignedFields(),
  highS = false,
  includePayee = false,
  prefix = "lnbc10n",
  timestamp = FIXED_TIMESTAMP,
} = {}) {
  const invoiceFields = includePayee
    ? [...fields, tagged("n", bech32.toWords(PUBLIC_KEY))]
    : fields;
  const signedWords = [
    ...fixedWidthWords(timestamp, 7),
    ...invoiceFields.flat(),
  ];
  const digest = sha256(concatBytes(new TextEncoder().encode(prefix), wordsToBytesPadded(signedWords)));
  const recovered = secp256k1.sign(digest, PRIVATE_KEY, {
    format: "recovered",
    lowS: true,
    prehash: false,
  });
  let recovery = recovered[0];
  const compact = recovered.slice(1);
  if (highS) {
    const high = CURVE_ORDER - bytesToBigInt(compact.slice(32));
    compact.set(bigIntToBytes(high, 32), 32);
    recovery ^= 1;
  }
  const signature = concatBytes(compact, Uint8Array.of(recovery));
  return bech32.encode(prefix, [...signedWords, ...bech32.toWords(signature)], false);
}

test("accepts the official exact-amount BOLT 11 vector and canonical URI/case forms", () => {
  const expected = {
    expectedSats: 250_000n,
    minimumRemainingSeconds: 0,
    nowSeconds: 1_496_314_658,
  };
  for (const input of [
    OFFICIAL_COFFEE,
    OFFICIAL_COFFEE.toUpperCase(),
    `lightning:${OFFICIAL_COFFEE}`,
    `LIGHTNING:${OFFICIAL_COFFEE.toUpperCase()}`,
  ]) {
    const invoice = validateBolt11Invoice(input, expected);
    assert.equal(invoice.amountMsat, 250_000_000n);
    assert.equal(invoice.canonicalInvoice, OFFICIAL_COFFEE);
    assert.equal(invoice.timestamp, 1_496_314_658);
    assert.equal(invoice.expirySeconds, 60);
    assert.equal(invoice.expiresAt, 1_496_314_718);
    assert.equal(invoice.paymentHash, "0001020304050607080900010203040506070809000102030405060708090102");
    assert.equal(invoice.payeeNodeId, "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad");
    assert.deepEqual(invoice.featureBits, [8, 14]);
    assert.equal(Object.isFrozen(invoice), true);
    assert.equal(Object.isFrozen(invoice.featureBits), true);
  }
});

test("fails closed on the official malformed, incompatible, and unsigned vectors", () => {
  for (const [code, expectedSats, invoice] of OFFICIAL_INVALID) {
    assert.throws(
      () => validateBolt11Invoice(invoice, {
        expectedSats,
        minimumRemainingSeconds: 0,
        nowSeconds: 1_496_314_658,
      }),
      assertCode(code),
      code,
    );
  }
  assert.throws(
    () => validateBolt11Invoice(OFFICIAL_DONATION_WITHOUT_AMOUNT, {
      expectedSats: 1n,
      nowSeconds: 1_496_314_658,
    }),
    assertCode("AMOUNT_REQUIRED"),
  );
  assert.throws(
    () => validateBolt11Invoice(OFFICIAL_TESTNET_FALLBACK, {
      expectedSats: 2_000_000n,
      nowSeconds: 1_496_314_658,
    }),
    assertCode("NETWORK"),
  );
  assert.throws(
    () => validateBolt11Invoice(OFFICIAL_MAINNET_FALLBACK, {
      expectedSats: 2_000_000n,
      minimumRemainingSeconds: 0,
      nowSeconds: 1_496_314_658,
    }),
    assertCode("FALLBACK"),
  );
});

test("enforces exact integer sats while accepting valid non-largest multipliers", () => {
  const picoInvoice = makeInvoice({ prefix: "lnbc10000p" });
  assert.equal(validateBolt11Invoice(picoInvoice, {
    expectedSats: 1n,
    nowSeconds: FIXED_TIMESTAMP,
  }).amountMsat, 1_000n);

  assert.throws(
    () => validateBolt11Invoice(makeInvoice(), { expectedSats: 2n, nowSeconds: FIXED_TIMESTAMP }),
    assertCode("AMOUNT_MISMATCH"),
  );
  assert.throws(
    () => validateBolt11Invoice(makeInvoice({ prefix: "lnbc1n" }), { expectedSats: 1n, nowSeconds: FIXED_TIMESTAMP }),
    assertCode("AMOUNT_SUB_SAT"),
  );
  assert.throws(
    () => validateBolt11Invoice(makeInvoice({ prefix: "lnbc01n" }), { expectedSats: 1n, nowSeconds: FIXED_TIMESTAMP }),
    assertCode("AMOUNT_FORMAT"),
  );
});

test("treats the remaining-time option as an inclusive minimum without accepting expiry", () => {
  const invoice = makeInvoice({ fields: unsignedFields({ expiry: 60 }) });
  assert.equal(validateBolt11Invoice(invoice, {
    expectedSats: 1n,
    minimumRemainingSeconds: 60,
    nowSeconds: FIXED_TIMESTAMP,
  }).expiresAt, FIXED_TIMESTAMP + 60);
  assert.throws(
    () => validateBolt11Invoice(invoice, {
      expectedSats: 1n,
      minimumRemainingSeconds: 60,
      nowSeconds: FIXED_TIMESTAMP + 1,
    }),
    assertCode("EXPIRED"),
  );
  assert.equal(validateBolt11Invoice(invoice, {
    expectedSats: 1n,
    minimumRemainingSeconds: 0,
    nowSeconds: FIXED_TIMESTAMP + 59,
  }).expirySeconds, 60);
  assert.throws(
    () => validateBolt11Invoice(invoice, {
      expectedSats: 1n,
      minimumRemainingSeconds: 0,
      nowSeconds: FIXED_TIMESTAMP + 60,
    }),
    assertCode("EXPIRED"),
  );

  const defaultExpiry = makeInvoice({ fields: unsignedFields({ expiry: null }) });
  assert.equal(validateBolt11Invoice(defaultExpiry, {
    expectedSats: 1n,
    nowSeconds: FIXED_TIMESTAMP,
  }).expirySeconds, DEFAULT_BOLT11_EXPIRY_SECONDS);
});

test("verifies low-S payee signatures and permits high-S only with public-key recovery", () => {
  const publicKeyHex = Buffer.from(PUBLIC_KEY).toString("hex");
  assert.equal(validateBolt11Invoice(makeInvoice(), {
    expectedSats: 1n,
    nowSeconds: FIXED_TIMESTAMP,
  }).payeeNodeId, publicKeyHex);
  assert.equal(validateBolt11Invoice(makeInvoice({ includePayee: true }), {
    expectedSats: 1n,
    nowSeconds: FIXED_TIMESTAMP,
  }).payeeNodeId, publicKeyHex);
  assert.equal(validateBolt11Invoice(makeInvoice({ highS: true }), {
    expectedSats: 1n,
    nowSeconds: FIXED_TIMESTAMP,
  }).payeeNodeId, publicKeyHex);
  assert.throws(
    () => validateBolt11Invoice(makeInvoice({ highS: true, includePayee: true }), {
      expectedSats: 1n,
      nowSeconds: FIXED_TIMESTAMP,
    }),
    assertCode("SIGNATURE"),
  );
});

test("ignores unknown odd features, rejects unknown even features, and requires minimal encoding", () => {
  const odd = makeInvoice({ fields: unsignedFields({ featureBits: [101] }) });
  assert.deepEqual(validateBolt11Invoice(odd, {
    expectedSats: 1n,
    nowSeconds: FIXED_TIMESTAMP,
  }).featureBits, [101]);

  const even = makeInvoice({ fields: unsignedFields({ featureBits: [100] }) });
  assert.throws(
    () => validateBolt11Invoice(even, { expectedSats: 1n, nowSeconds: FIXED_TIMESTAMP }),
    assertCode("FEATURE_REQUIRED"),
  );

  const nonMinimalFeature = makeInvoice({
    fields: [
      ...unsignedFields({ featureBits: [] }),
      tagged("9", [0, ...featureWords([17])]),
    ],
  });
  assert.throws(
    () => validateBolt11Invoice(nonMinimalFeature, { expectedSats: 1n, nowSeconds: FIXED_TIMESTAMP }),
    assertCode("FEATURE_FORMAT"),
  );
});

test("rejects non-zero fixed-field padding even when the invoice signature is valid", () => {
  const paymentHash = bech32.toWords(Uint8Array.from({ length: 32 }, (_, index) => index));
  const paymentSecret = bech32.toWords(new Uint8Array(32).fill(0x11));
  const descriptionHash = bech32.toWords(sha256(new TextEncoder().encode("external description")));
  const description = tagged("d", bech32.toWords(new TextEncoder().encode("exact trade")));
  const expiry = tagged("x", minimalWords(600));

  for (const [type, corruptWords, otherDescription] of [
    ["p", paymentHash, description],
    ["s", paymentSecret, description],
    ["h", descriptionHash, null],
  ]) {
    const corrupted = [...corruptWords];
    corrupted[corrupted.length - 1] |= 1;
    const fields = [
      tagged("p", type === "p" ? corrupted : paymentHash),
      tagged("s", type === "s" ? corrupted : paymentSecret),
      type === "h" ? tagged("h", corrupted) : otherDescription,
      expiry,
    ];
    const invoice = makeInvoice({ fields });
    assert.throws(
      () => validateBolt11Invoice(invoice, { expectedSats: 1n, nowSeconds: FIXED_TIMESTAMP }),
      assertCode("FORMAT"),
      type,
    );
  }
});

test("rejects malformed input and invalid validation authority before parsing", () => {
  for (const input of [
    "",
    ` ${OFFICIAL_COFFEE}`,
    `${OFFICIAL_COFFEE}\n`,
    `lightning://${OFFICIAL_COFFEE}`,
    `${OFFICIAL_COFFEE.slice(0, 20).toUpperCase()}${OFFICIAL_COFFEE.slice(20)}`,
    "x".repeat(MAX_BOLT11_LENGTH + 1),
  ]) {
    assert.throws(
      () => validateBolt11Invoice(input, { expectedSats: 250_000n, nowSeconds: 1_496_314_658 }),
      Bolt11InvoiceError,
      input.slice(0, 30),
    );
  }
  for (const expectedSats of [1, "1", 0n, -1n, 2_100_000_000_000_001n, null]) {
    assert.throws(
      () => validateBolt11Invoice(OFFICIAL_COFFEE, { expectedSats, nowSeconds: 1_496_314_658 }),
      assertCode("EXPECTED_AMOUNT"),
    );
  }
  for (const options of [
    { expectedSats: 250_000n, nowSeconds: 0 },
    { expectedSats: 250_000n, nowSeconds: Number.NaN },
    { expectedSats: 250_000n, minimumRemainingSeconds: -1, nowSeconds: 1_496_314_658 },
    { expectedSats: 250_000n, minimumRemainingSeconds: 0.5, nowSeconds: 1_496_314_658 },
  ]) {
    assert.throws(() => validateBolt11Invoice(OFFICIAL_COFFEE, options), assertCode("CLOCK"));
  }
});
