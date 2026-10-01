import assert from "node:assert/strict";
import test from "node:test";
import { bech32, bech32m } from "@scure/base";
import { decodeKnownMainnetAddress } from "../app/lib/bitcoin-address-script.mjs";
import { createOnchainRequest } from "../app/lib/onchain-request.mjs";

// Single-case SegWit encodings: https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki
// Witness checksum variants: https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki
const SEGWIT_CASES = [
  {
    address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    scriptType: "p2wpkh",
    scriptPubKeyHex: "0014751e76e8199196d454941c45d1b3a323f1433bd6",
    codec: bech32,
  },
  {
    address: "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
    scriptType: "p2tr",
    scriptPubKeyHex: "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    codec: bech32m,
  },
];

test("all-uppercase SegWit v0 and v1 input produces the same canonical address, script and amount URI", () => {
  for (const { address, scriptType, scriptPubKeyHex } of SEGWIT_CASES) {
    const lowercase = createOnchainRequest(address, 21n);
    const uppercase = createOnchainRequest(address.toUpperCase(), 21n);
    assert.deepEqual(uppercase, lowercase);
    assert.deepEqual(uppercase, {
      address, btcAmount: "0.00000021", sats: "21", scriptType,
      uri: `bitcoin:${address}?amount=0.00000021`,
    });
    assert.equal(decodeKnownMainnetAddress(uppercase.address).scriptPubKeyHex, scriptPubKeyHex);
  }
});

test("mixed-case SegWit input is rejected instead of being repaired by case folding", () => {
  for (const { address } of SEGWIT_CASES) {
    for (const mixed of [
      `BC1${address.slice(3)}`,
      `bc1${address.slice(3).toUpperCase()}`,
      `${address.slice(0, 3)}${address[3].toUpperCase()}${address.slice(4)}`,
    ]) assert.throws(() => createOnchainRequest(mixed, 21n), { code: "ADDRESS_INVALID" });
  }
});

test("uppercase normalization does not bypass checksum, network or witness restrictions", () => {
  for (const { address, codec } of SEGWIT_CASES) {
    const upper = address.toUpperCase();
    const invalidChecksum = `${upper.slice(0, -1)}${upper.endsWith("Q") ? "P" : "Q"}`;
    assert.throws(() => createOnchainRequest(invalidChecksum, 21n), { code: "ADDRESS_INVALID" });
    const words = codec.decode(address).words;
    for (const prefix of ["tb", "bcrt"]) {
      const otherNetwork = codec.encode(prefix, words).toUpperCase();
      assert.throws(() => createOnchainRequest(otherNetwork, 21n), { code: "ADDRESS_INVALID" });
    }
  }
  const unsupportedVersion = bech32m.encode("bc", [2, ...bech32.toWords(new Uint8Array(32).fill(17))]).toUpperCase();
  assert.throws(() => createOnchainRequest(unsupportedVersion, 21n), { code: "ADDRESS_INVALID" });
  const invalidTaprootPoint = bech32m.encode("bc", [1, ...bech32.toWords(new Uint8Array(32).fill(255))]).toUpperCase();
  assert.throws(() => createOnchainRequest(invalidTaprootPoint, 21n), { code: "ADDRESS_INVALID" });
});

test("Base58 remains case-sensitive and the raw-address boundary still rejects URI and whitespace", () => {
  const base58 = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
  assert.equal(createOnchainRequest(base58, 21n).address, base58);
  for (const altered of [base58.toUpperCase(), base58.toLowerCase()]) {
    assert.throws(() => createOnchainRequest(altered, 21n), { code: "ADDRESS_INVALID" });
  }
  const uppercase = SEGWIT_CASES[0].address.toUpperCase();
  for (const invalid of [` ${uppercase}`, `${uppercase}\n`, `bitcoin:${uppercase}?amount=0.00000021`]) {
    assert.throws(() => createOnchainRequest(invalid, 21n), { code: "ADDRESS_FORMAT" });
  }
});

test("the canonical address decoder stays strict for signed and canonical callers", () => {
  for (const { address } of SEGWIT_CASES) {
    assert.equal(decodeKnownMainnetAddress(address).canonicalAddress, address);
    assert.throws(() => decodeKnownMainnetAddress(address.toUpperCase()), { code: "ADDRESS_NONCANONICAL" });
    assert.throws(() => decodeKnownMainnetAddress(`BC1${address.slice(3)}`), { code: "ADDRESS_NONCANONICAL" });
  }
});
