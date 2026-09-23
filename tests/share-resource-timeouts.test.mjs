import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { shareImageFile } from "../app/lib/share-transport.mjs";
import { decodeQrSymbols } from "../app/lib/verified-qr.mjs";

test("a stalled clipboard cannot keep the completed download waiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const downloads = [];
  const feedback = [];
  let completeCopy;
  const copy = new Promise((resolve) => { completeCopy = resolve; });
  const sharing = shareImageFile({
    file: { name: "trade.png", type: "image/png" },
    title: "거래 기록",
    text: "조건 기록",
    download: (file) => downloads.push(file),
    verificationUrl: "https://example.test/verify/?id=record",
    copyVerificationUrl: () => copy,
    onDownloadFallback: (event) => feedback.push(event),
  });
  await setImmediate();
  assert.equal(downloads.length, 1);
  t.mock.timers.tick(1_200);
  assert.equal(await sharing, "downloaded");
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].verificationUrlDelivery, "copy-failed");
  completeCopy();
  await setImmediate();
  assert.equal(feedback.length, 1, "late clipboard completion must not repeat delivery or finalize");
  assert.equal(downloads.length, 1);
});

test("stalled optional fonts and logo finish with a verified plain QR and allow a later retry", async (t) => {
  // Load the real renderer with Node's TS stripper; browser globals below only
  // replace the DOM canvas transport, while QR encoding/decoding stay real.
  const sourceUrl = new URL("../app/lib/trade-share-image.ts", import.meta.url);
  const source = (await readFile(sourceUrl, "utf8")).replace(/from "(\.\/[^"\n]+)"/gu, (_, path) => {
    const resolved = new URL(path.endsWith(".mjs") ? path : `${path}.ts`, sourceUrl);
    return `from "${resolved.href}"`;
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
  const { createTradeShareImage, materializeTradeShareImage } = await import(moduleUrl);
  const images = [];
  const drawnQrs = [];
  let failLogoImmediately = false;
  let finishFonts;
  const fontsReady = new Promise((resolve) => { finishFonts = resolve; });
  class TestImage {
    onload = null;
    onerror = null;
    set src(value) {
      this.source = value;
      if (value && failLogoImmediately) queueMicrotask(() => this.onerror?.());
    }
    constructor() { images.push(this); }
  }
  const createCanvas = () => {
    const canvas = { width: 0, height: 0, raster: null };
    const context = new Proxy({
      measureText: () => ({ width: 80 }),
      createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (image) => { canvas.raster = { ...image, data: image.data.slice() }; },
      drawImage: (image) => { if (image.raster) drawnQrs.push(image.raster); },
    }, { get: (target, property) => target[property] ?? (() => {}) });
    canvas.getContext = () => context;
    canvas.toBlob = (callback) => callback(new Blob(["canvas output"], { type: "image/png" }));
    return canvas;
  };
  for (const [name, value] of Object.entries({
    Image: TestImage,
    Path2D: class {},
    document: { fonts: { ready: fontsReady }, createElement: createCanvas },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  const verificationUrl = "https://example.test/verify/?id=abcdefghijklmnop";
  const input = {
    tradeRole: "buyer", amountBasis: "krw", bitcoinDisplayUnit: "sats",
    referenceLabel: "업비트", referencePriceKrw: 100_000_000,
    referenceTime: new Date().toISOString(), koreaPremiumRatio: null,
    sellerPremiumPercent: 0, buyerFundingSource: "기재하지 않음",
    paymentKrw: 100_000, sats: 100_000, btcAmount: 0.001,
    appliedPriceKrw: "100000000", payment: null,
    record: { id: "abcdefghijklmnop", createdAt: new Date().toISOString(), verificationUrl },
  };
  const request = await createTradeShareImage(input);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rendering = materializeTradeShareImage(request);
  await setImmediate();
  assert.equal(images.length, 0, "renderer is still waiting for fonts");
  t.mock.timers.tick(1_500);
  await setImmediate();
  assert.equal(images.length, 1, "system fonts allow QR preparation after the font deadline");
  const lateLoad = images[0].onload;
  t.mock.timers.tick(1_500);
  const file = await rendering;
  assert.equal(file.type, "image/png");
  assert.equal(images[0].source, "", "timed out image loading is cancelled");
  assert.equal(images[0].onload, null);
  assert.equal(images[0].onerror, null);
  assert.deepEqual(decodeQrSymbols(drawnQrs[0]), [verificationUrl]);
  lateLoad();
  finishFonts();
  await setImmediate();
  assert.equal(drawnQrs.length, 1, "late asset completion must not redraw the delivered card");

  failLogoImmediately = true;
  await materializeTradeShareImage(request);
  assert.equal(images.length, 2, "a timeout must not poison future logo attempts");
  assert.deepEqual(decodeQrSymbols(drawnQrs[1]), [verificationUrl]);
});
