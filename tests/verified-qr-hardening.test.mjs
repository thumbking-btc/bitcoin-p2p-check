import assert from "node:assert/strict";
import test from "node:test";

import {
  VerifiedQrError,
  createVerifiedTextQr,
  decodeQrSymbols,
  verifyQrRasterPayload,
} from "../app/lib/verified-qr.mjs";

const BOLT11_PAYLOAD = "LNBC2500U1PVJLUEZSP5ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYGSPP5QQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQYPQDQ5XYSXXATSYP3K7ENXV4JSXQZPU9QRSGQUK0RL77NJ30YXDY8J9VDX85FKPMDLA2087NE0XH8NHEDH8W27KYKE0LP53UT353S06FV3QFEGEXT0EH0YMJPF39TUVEN09SAM30G4VGPFNA3RH";

function assertCode(code) {
  return (error) => error instanceof VerifiedQrError && error.code === code;
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [...image.data.slice(offset, offset + 4)];
}

function embedQr(qr, margin = 29) {
  const width = qr.width + margin * 2;
  const height = qr.height + margin * 2;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let y = 0; y < qr.height; y += 1) {
    const source = qr.data.subarray(y * qr.width * 4, (y + 1) * qr.width * 4);
    data.set(source, ((y + margin) * width + margin) * 4);
  }
  return { data, height, width };
}

test("renders and independently decodes exact ASCII payment payloads", () => {
  for (const payload of [
    "bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.00000001",
    BOLT11_PAYLOAD,
  ]) {
    const qr = createVerifiedTextQr(payload);
    assert.equal(qr.payload, payload);
    assert.equal(qr.width, qr.height);
    assert.ok(Number.isSafeInteger(qr.width) && qr.width > 0 && qr.width <= 640);
    assert.equal(qr.data.length, qr.width * qr.height * 4);
    assert.deepEqual(decodeQrSymbols(qr), [payload]);
    assert.equal(verifyQrRasterPayload(qr, payload), true);

    const colors = new Set();
    for (let index = 0; index < qr.data.length; index += 4) {
      assert.equal(qr.data[index], qr.data[index + 1]);
      assert.equal(qr.data[index], qr.data[index + 2]);
      assert.equal(qr.data[index + 3], 255);
      colors.add(qr.data[index]);
    }
    assert.deepEqual([...colors].sort((left, right) => left - right), [0, 255]);

    // Four quiet-zone modules at a minimum of two pixels per module.
    for (let offset = 0; offset < 8; offset += 1) {
      for (let coordinate = 0; coordinate < qr.width; coordinate += 1) {
        assert.deepEqual(pixel(qr, coordinate, offset), [255, 255, 255, 255]);
        assert.deepEqual(pixel(qr, coordinate, qr.height - 1 - offset), [255, 255, 255, 255]);
        assert.deepEqual(pixel(qr, offset, coordinate), [255, 255, 255, 255]);
        assert.deepEqual(pixel(qr, qr.width - 1 - offset, coordinate), [255, 255, 255, 255]);
      }
    }
  }
});

test("finds the exact QR once when it is embedded in a larger private image", () => {
  const qr = createVerifiedTextQr(BOLT11_PAYLOAD, { maximumPixelSize: 580, level: "M" });
  const fullImage = embedQr(qr);
  assert.deepEqual(decodeQrSymbols(fullImage), [BOLT11_PAYLOAD]);
  assert.equal(verifyQrRasterPayload(fullImage, BOLT11_PAYLOAD), true);
});

test("wipes generated pixels after absent, duplicate, mismatched, or thrown verification", () => {
  for (const decoded of [[], ["request", "request"], ["wrong"]]) {
    let captured;
    assert.throws(
      () => createVerifiedTextQr("request", {
        decodeSymbols: (image) => {
          captured = image.data;
          return decoded;
        },
      }),
      assertCode("QR_VERIFY"),
    );
    assert.ok(captured);
    assert.equal(captured.every((value) => value === 0), true);
  }

  let captured;
  assert.throws(
    () => createVerifiedTextQr("request", {
      decodeSymbols: (image) => {
        captured = image.data;
        throw new Error("decoder failed");
      },
    }),
    assertCode("QR_VERIFY"),
  );
  assert.equal(captured.every((value) => value === 0), true);
});

test("wipes a supplied image when its decoded payload does not match", () => {
  const qr = createVerifiedTextQr("exact request");
  const fullImage = embedQr(qr);
  assert.throws(
    () => verifyQrRasterPayload(fullImage, "different request"),
    assertCode("QR_VERIFY"),
  );
  assert.equal(fullImage.data.every((value) => value === 0), true);
});

test("uses an explicit UTF-8 ECI segment when ISO-8859-1 cannot preserve the text", () => {
  const payload = "한글 QR 검증 · ₿";
  const qr = createVerifiedTextQr(payload);
  assert.deepEqual(decodeQrSymbols(qr), [payload]);
  assert.equal(verifyQrRasterPayload(qr, payload), true);
});

test("rejects invalid generation options before a zero-sized or oversized raster can pass", () => {
  const invalidOptions = [
    { maximumLength: Number.NaN },
    { maximumLength: 0 },
    { maximumLength: 1.5 },
    { maximumLength: "1200" },
    { maximumPixelSize: Number.NaN },
    { maximumPixelSize: Number.POSITIVE_INFINITY },
    { maximumPixelSize: 0 },
    { maximumPixelSize: -1 },
    { maximumPixelSize: 640.5 },
    { maximumPixelSize: "640" },
    { maximumPixelSize: 2_049 },
    { quietZoneModules: Number.NaN },
    { quietZoneModules: -1 },
    { quietZoneModules: 0 },
    { quietZoneModules: 3 },
    { quietZoneModules: 4.5 },
    { quietZoneModules: "4" },
    { level: "Z" },
    { decodeSymbols: "not a function" },
  ];
  for (const options of invalidOptions) {
    assert.throws(
      () => createVerifiedTextQr("request", {
        ...options,
        ...(Object.hasOwn(options, "decodeSymbols") ? {} : { decodeSymbols: () => ["request"] }),
      }),
      assertCode("QR_OPTIONS"),
      JSON.stringify(options),
    );
  }
  assert.throws(
    () => createVerifiedTextQr("request", { maximumPixelSize: 40 }),
    assertCode("QR_CAPACITY"),
  );
});

test("rejects malformed image containers without leaking secondary TypeErrors", () => {
  assert.throws(() => verifyQrRasterPayload(null, "request"), assertCode("QR_IMAGE"));
  assert.throws(() => decodeQrSymbols({}), assertCode("QR_IMAGE"));

  for (const image of [
    { data: new Uint8ClampedArray(4), height: 0, width: 1 },
    { data: new Uint8ClampedArray(4), height: 1, width: 0 },
    { data: new Uint8ClampedArray(3), height: 1, width: 1 },
    { data: new Uint8Array(4), height: 1, width: 1 },
    { data: new Uint8ClampedArray(4), height: 1.5, width: 1 },
  ]) {
    assert.throws(() => verifyQrRasterPayload(image, "request"), assertCode("QR_IMAGE"));
    assert.equal(image.data.every((value) => value === 0), true);
  }

  const qr = createVerifiedTextQr("request");
  assert.throws(() => verifyQrRasterPayload(qr, null), assertCode("QR_INPUT"));
  assert.equal(qr.data.every((value) => value === 0), true);
});
