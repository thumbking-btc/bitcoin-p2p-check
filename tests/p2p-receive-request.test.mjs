import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_P2P_RECEIVE_SATS,
  P2PReceiveRequestError,
  assertP2PReceiveAddressInputSafe,
  createP2PReceiveRequest,
  createVerifiedP2PReceiveQr,
  formatSatsAsBtcAmount,
} from "../app/lib/p2p-receive-request.mjs";
import { decodeKnownMainnetAddress } from "../app/lib/bitcoin-address-script.mjs";

const ADDRESSES = Object.freeze([
  ["1BoatSLRHtKNngkdXEeobR76b53LETtpyT", "p2pkh", "76a9147680adec8eabcabac676be9e83854ade0bd22cdb88ac"],
  ["3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "p2sh", "a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87"],
  ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "p2wpkh", "0014751e76e8199196d454941c45d1b3a323f1433bd6"],
  ["bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", "p2wsh", "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262"],
  ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "p2tr", "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"],
]);

function build(address, sats = 12_345_678n) {
  return createP2PReceiveRequest({
    address,
    addressConfirmed: true,
    amountConfirmed: true,
    sats,
  });
}

test("formats exact sats without floating-point or trailing zeroes", () => {
  assert.equal(formatSatsAsBtcAmount(1n), "0.00000001");
  assert.equal(formatSatsAsBtcAmount(10n), "0.0000001");
  assert.equal(formatSatsAsBtcAmount(100_000_000n), "1");
  assert.equal(formatSatsAsBtcAmount(MAX_P2P_RECEIVE_SATS), "21000000");
  for (const invalid of [0n, MAX_P2P_RECEIVE_SATS + 1n, 1, "1", null]) {
    assert.throws(() => formatSatsAsBtcAmount(invalid), P2PReceiveRequestError);
  }
});

test("accepts five canonical mainnet types and creates one minimal BIP 321 URI", () => {
  for (const [address, scriptType, scriptPubKeyHex] of ADDRESSES) {
    assert.deepEqual(decodeKnownMainnetAddress(address), {
      canonicalAddress: address,
      scriptType,
      scriptPubKeyHex,
    });
    const request = build(address);
    assert.deepEqual(request, {
      address,
      btcAmount: "0.12345678",
      sats: "12345678",
      scriptType,
      uri: "bitcoin:" + address + "?amount=0.12345678",
    });
    assert.equal(Object.isFrozen(request), true);
    assert.equal(/[&;]|label=|message=|lightning=|req-/i.test(request.uri), false);
  }
});

test("rejects and identifies likely secret material before address handling", () => {
  for (const unsafe of [
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "KwFfpDsaF7yxCELuyrH9gP5XL7TAt5b9HPWC1xCQbmrxvhJgMQHb",
    "  KwFfpDsaF7yxCELuyrH9gP5XL7TAt5b9HPWC1xCQbmrxvhJgMQHb  ",
    "wpkh(KwFfpDsaF7yxCELuyrH9gP5XL7TAt5b9HPWC1xCQbmrxvhJgMQHb)",
    "0000000000000000000000000000000000000000000000000000000000000001",
    "  0000000000000000000000000000000000000000000000000000000000000001 ",
    "wpkh(xprv9s21ZrQH143K3J7QxQRCW3K4FakePrivateMaterialForSafetyCheck/0/*)",
    "S6c56bnXQiBjk9mqSYE7ykVQ7NzrRy",
    "6PRVWUbkzzsbcVacx47pLTdRzH7mATW1a9BjjbMfLRqQd1YFhY9UjBuU9D",
    "000102030405060708091011121314151617181920212223",
    "ur:crypto-seed/oeadcsss",
    "一 二 三 四 五 六 七 八 九 十 百 千",
    "x".repeat(91),
    "1" + "a".repeat(62),
    "1".repeat(47),
    "1 abandon ability able about above absent absorb abstract absurd abuse access accident",
  ]) {
    assert.throws(
      () => assertP2PReceiveAddressInputSafe(unsafe),
      (error) => error instanceof P2PReceiveRequestError && error.code === "ADDRESS_UNSAFE",
      unsafe,
    );
  }
  for (const partial of ["", "1", "3", "b", "bc", "bc1"] ) {
    assert.equal(assertP2PReceiveAddressInputSafe(partial), partial);
  }
  assert.equal(assertP2PReceiveAddressInputSafe(ADDRESSES[4][0]), ADDRESSES[4][0]);
});

test("fails closed on missing authority, URI input, testnet, whitespace, and malformed addresses", () => {
  const address = ADDRESSES[2][0];
  assert.throws(
    () => createP2PReceiveRequest({ address, addressConfirmed: false, amountConfirmed: true, sats: 1n }),
    (error) => error.code === "ADDRESS_CONFIRMATION",
  );
  assert.throws(
    () => createP2PReceiveRequest({ address, addressConfirmed: true, amountConfirmed: false, sats: 1n }),
    (error) => error.code === "AMOUNT_CONFIRMATION",
  );
  for (const invalid of [
    " " + address,
    address + "\n",
    "bitcoin:" + address,
    "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
    address.toUpperCase(),
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "KwFfpDsaF7yxCELuyrH9gP5XL7TAt5b9HPWC1xCQbmrxvhJgMQHb",
  ]) {
    assert.throws(() => build(invalid, 1n), P2PReceiveRequestError, invalid);
  }
});

test("rendered QR pixels decode exactly once to the original URI", () => {
  const request = build(ADDRESSES[4][0], MAX_P2P_RECEIVE_SATS);
  const qr = createVerifiedP2PReceiveQr(request);
  assert.equal(qr.payload, request.uri);
  assert.equal(qr.width, qr.height);
  assert.equal(qr.data.length, qr.width * qr.height * 4);
  const colors = new Set();
  for (let index = 0; index < qr.data.length; index += 4) {
    assert.equal(qr.data[index], qr.data[index + 1]);
    assert.equal(qr.data[index], qr.data[index + 2]);
    assert.equal(qr.data[index + 3], 255);
    colors.add(qr.data[index]);
  }
  assert.deepEqual([...colors].sort((left, right) => left - right), [0, 255]);
});

test("QR verification wipes the raster on absent, duplicate, mismatched, and thrown decodes", () => {
  const request = build(ADDRESSES[0][0], 1n);
  for (const decoded of [[], [request.uri, request.uri], ["bitcoin:wrong?amount=1"]]) {
    let captured;
    assert.throws(
      () => createVerifiedP2PReceiveQr(request, {
        decodeSymbols: (image) => {
          captured = image.data;
          return decoded;
        },
      }),
      (error) => error.code === "QR_VERIFY",
    );
    assert.ok(captured);
    assert.equal(captured.every((value) => value === 0), true);
  }
  let captured;
  assert.throws(
    () => createVerifiedP2PReceiveQr(request, {
      decodeSymbols: (image) => {
        captured = image.data;
        throw new Error("decode failed");
      },
    }),
    (error) => error.code === "QR_VERIFY",
  );
  assert.equal(captured.every((value) => value === 0), true);
});

test("QR verification rejects forged or internally inconsistent request objects", () => {
  const valid = build(ADDRESSES[0][0], 100_000_000n);
  for (const forged of [
    { address: "not-a-bitcoin-address", btcAmount: "1", sats: "100000000", scriptType: "p2pkh", uri: "bitcoin:not-a-bitcoin-address?amount=1" },
    { ...valid, sats: "1" },
    { ...valid, btcAmount: "1.0", uri: "bitcoin:" + valid.address + "?amount=1.0" },
    { ...valid, scriptType: "p2tr" },
    { ...valid, extra: true },
  ]) {
    assert.throws(
      () => createVerifiedP2PReceiveQr(forged),
      (error) => error instanceof P2PReceiveRequestError && error.code === "QR_PAYLOAD",
    );
  }
});

test("payment request flows are buyer-authorized, local-only, short-lived, and outside public promotion sharing", async () => {
  const [component, lightning, wrapper, tradeTool, core, draft, link, promotion, promotionImage, privateImage, shareTransport, worker, serviceWorker] = await Promise.all([
    readFile(new URL("../app/components/P2PReceiveRequest.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/P2PLightningRequest.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/P2PPaymentRequest.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/P2PTradeTool.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/p2p-receive-request.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-draft.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-link.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-promotion.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-promotion-image.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/private-request-image.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/share-transport.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);

  assert.match(tradeTool, /<P2PPaymentRequest/);
  assert.match(wrapper, /BTC 받을 방법 선택/);
  assert.match(wrapper, /온체인/);
  assert.match(wrapper, /라이트닝/);
  assert.match(wrapper, /rail === "onchain"/);
  assert.match(wrapper, /rail === "lightning"/);
  assert.match(wrapper, /이번 모집에서 미지원/);
  assert.match(component, /전체 주소/);
  assert.match(component, /채굴 수수료를 별도로 부담/);
  assert.match(component, /REQUEST_LIFETIME_MS = 10 \* 60_000/);
  assert.match(component, /visibilitychange/);
  assert.match(component, /pagehide/);
  assert.match(component, /pageshow/);
  assert.match(component, /artifactRef\.current\?\.qr\.data\.fill\(0\)/);
  assert.match(component, /generationRef\.current !== generation/);
  assert.match(component, /useLayoutEffect\(\(\) => \{[\s\S]*?mountedRef\.current = false;[\s\S]*?clearArtifactSurface\(\)/);
  assert.match(component, /나는 BTC를 받을 구매자이며/);
  assert.match(component, /고정 원화 조건/);
  assert.match(component, /상호 재확인 기한/);
  assert.match(component, /주소는 거래 조건 공유 링크·거래 조건 이미지·서버에는 넣지 않습니다/);
  assert.match(component, /저장한 QR PNG에는 전체 주소·금액이 포함됩니다/);
  assert.match(component, /주소 소유·새 주소·미사용 여부/);
  assert.match(component, /Script Hash \(P2SH\)/);
  assert.doesNotMatch(component, /Wrapped SegWit \(P2SH\)/);
  assert.match(tradeTool, /setManualMarketGeneration\(\(current\) => current \+ 1\);\s*await refreshMarket\("manual"\)/);
  assert.match(tradeTool, /isReferenceShareable\(\{ marketState, referenceTime \}, Date\.now\(\)\)/);
  assert.match(tradeTool, /const receiveQuoteKey = JSON\.stringify\(\{[\s\S]*?fundingSource,[\s\S]*?bitcoinDisplayUnit,[\s\S]*?manualMarketGeneration/);
  assert.doesNotMatch(tradeTool.match(/const receiveQuoteKey = JSON\.stringify\(\{[\s\S]*?\}\);/)?.[0] ?? "", /referencePrice|referenceTime|market/);
  assert.match(lightning, /validateBolt11Invoice/);
  assert.match(lightning, /createVerifiedTextQr/);
  assert.match(lightning, /resultRef\.current\.hidden = true/);
  assert.match(lightning, /resultRef\.current\.hidden = false/);
  assert.match(lightning, /상호 재확인 기한/);
  assert.match(lightning, /useLayoutEffect\(\(\) => \{[\s\S]*?mountedRef\.current = false;[\s\S]*?clearArtifactSurface\(\)/);
  assert.match(lightning, /원화를 먼저 보내더라도 BTC 지급이 보장되지는 않습니다/);
  assert.match(lightning, /인보이스는 서버·URL·저장소·공개 모집물에 넣지 않습니다/);
  for (const sensitiveComponent of [component, lightning]) {
    assert.match(sensitiveComponent, /isReferenceShareable\(\{ marketState: quoteCurrent \? "ready" : "error", referenceTime \}, Date\.now\(\)\)/);
  }
  for (const sensitiveComponent of [component, lightning]) {
    assert.doesNotMatch(sensitiveComponent, /\bfetch\s*\(|localStorage|sessionStorage|indexedDB|document\.cookie|location\.|history\.|console\./);
    assert.match(sensitiveComponent, /shareSensitiveImageFile/);
    assert.doesNotMatch(sensitiveComponent, /shareImageFile\s*\(/);
  }
  assert.match(shareTransport, /Sensitive address\/invoice images never fall back/);
  const sensitiveShareBlock = shareTransport.slice(shareTransport.indexOf("export async function shareSensitiveImageFile"));
  assert.doesNotMatch(sensitiveShareBlock, /download\(/);
  assert.match(privateImage, /verifyQrRasterPayload\(fullImage, verified\.payload\)/);
  assert.match(privateImage, /rail: "onchain"/);
  assert.match(privateImage, /rail: "lightning"/);

  assert.doesNotMatch(promotion, /fundingSource|address|invoice|https?:|bitcoin:/i);
  assert.doesNotMatch(promotionImage, /fundingSource|address|invoice|https?:|bitcoin:/i);
  assert.doesNotMatch(tradeTool, /buildTradeFragment|현재 시세로 다시 계산하기:/);
  for (const source of [core, draft, link, promotion, promotionImage, worker, serviceWorker]) {
    assert.doesNotMatch(source, /receiveAddress|recipientAddress|paymentRequestUri|p2p-receive-address/);
  }
});
