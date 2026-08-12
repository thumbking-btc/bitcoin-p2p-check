import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { calculateP2PQuote, MAX_SATS } from "../app/lib/p2p-quote.mjs";
import { isReferenceShareable, shareImageFile } from "../app/lib/share-transport.mjs";

async function readPngSize(url) {
  const buffer = await readFile(url);
  assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function render(pathname = "/") {
  const relativePath = pathname === "/"
    ? "../dist/client/index.html"
    : `../dist/client${pathname.replace(/\/$/, "")}/index.html`;
  const html = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

test("calculates buyer and seller quotes without hiding fees", () => {
  const buyer = calculateP2PQuote({ mode: "krw", amount: 3_000_000, referencePrice: 100_000_000, premiumPercent: 2 });
  assert.ok(buyer);
  assert.equal(buyer.appliedPrice, 102_000_000);
  assert.equal(buyer.paymentKrw, 3_000_000);
  assert.equal(buyer.sats, 2_941_176);

  const seller = calculateP2PQuote({ mode: "sats", amount: 3_000_000, referencePrice: 100_000_000, premiumPercent: 2 });
  assert.ok(seller);
  assert.equal(seller.sats, 3_000_000);
  assert.equal(seller.paymentKrw, 3_060_000);

  const buyerDiscount = calculateP2PQuote({ mode: "krw", amount: 3_000_000, referencePrice: 100_000_000, premiumPercent: -2 });
  assert.equal(buyerDiscount?.sats, 3_061_224);
  const sellerDiscount = calculateP2PQuote({ mode: "sats", amount: 3_000_000, referencePrice: 100_000_000, premiumPercent: -2 });
  assert.equal(sellerDiscount?.paymentKrw, 2_940_000);
});

test("rejects invalid, zero-result, non-finite, and out-of-range quotes", () => {
  assert.equal(calculateP2PQuote({ mode: "krw", amount: 0, referencePrice: 100_000_000, premiumPercent: 2 }), null);
  assert.equal(calculateP2PQuote({ mode: "krw", amount: 1, referencePrice: 100_000_000, premiumPercent: -100 }), null);
  assert.equal(calculateP2PQuote({ mode: "krw", amount: 1, referencePrice: 100_000_000, premiumPercent: Infinity }), null);
  assert.equal(calculateP2PQuote({ mode: "krw", amount: 0.1, referencePrice: 100_000_000, premiumPercent: 0 }), null);
  assert.equal(calculateP2PQuote({ mode: "sats", amount: MAX_SATS + 1, referencePrice: 100_000_000, premiumPercent: 0 }), null);
});

test("shares a PNG file and downloads only when file sharing is unavailable", async () => {
  const file = { name: "bitcoin-p2p-trade.png", type: "image/png" };
  let sharedPayload = null;
  const downloaded = [];

  const shared = await shareImageFile({
    file,
    title: "비트코인 P2P 거래 조건",
    text: "거래 조건",
    nativeCanShare: (data) => data.files?.[0] === file,
    nativeShare: async (data) => { sharedPayload = data; },
    download: (value) => downloaded.push(value),
  });
  assert.equal(shared, "shared");
  assert.equal(sharedPayload.files[0], file);
  assert.equal(downloaded.length, 0);

  const unsupported = await shareImageFile({
    file,
    title: "비트코인 P2P 거래 조건",
    text: "거래 조건",
    nativeCanShare: () => false,
    nativeShare: async () => { throw new Error("must not run"); },
    download: (value) => downloaded.push(value),
  });
  assert.equal(unsupported, "downloaded");
  assert.equal(downloaded.length, 1);

  const abortError = new Error("cancelled");
  abortError.name = "AbortError";
  const cancelled = await shareImageFile({
    file,
    title: "비트코인 P2P 거래 조건",
    text: "거래 조건",
    nativeCanShare: () => true,
    nativeShare: async () => { throw abortError; },
    download: (value) => downloaded.push(value),
  });
  assert.equal(cancelled, "cancelled");
  assert.equal(downloaded.length, 1);

  const recovered = await shareImageFile({
    file,
    title: "비트코인 P2P 거래 조건",
    text: "거래 조건",
    nativeCanShare: () => true,
    nativeShare: async () => { throw new Error("share failed"); },
    download: (value) => downloaded.push(value),
  });
  assert.equal(recovered, "downloaded-after-error");
  assert.equal(downloaded.length, 2);
});

test("blocks stale or loading Upbit references but permits committed manual prices", () => {
  const observedAt = "2026-08-11T00:00:00.000Z";
  const base = Date.parse(observedAt);
  assert.equal(isReferenceShareable({ referenceMode: "upbit", marketState: "ready", referenceTime: observedAt }, base + 299_999), true);
  assert.equal(isReferenceShareable({ referenceMode: "upbit", marketState: "ready", referenceTime: observedAt }, base + 300_000), false);
  assert.equal(isReferenceShareable({ referenceMode: "upbit", marketState: "loading", referenceTime: observedAt }, base), false);
  assert.equal(isReferenceShareable({ referenceMode: "manual", marketState: "loading", referenceTime: null }, base), true);
});

test("renders a focused, capture-ready P2P calculator", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = (await response.text()).replace(/<!-- -->/g, "");

  assert.match(html, /<title>비트코인 P2P 계산기<\/title>/);
  assert.match(html, /<h1[^>]*>비트코인 P2P 계산기<\/h1>/);
  assert.match(html, /data-capture-card/);
  assert.match(html, /나는 비트코인을/);
  assert.match(html, /삽니다/);
  assert.match(html, /원화 보내고 BTC 받기/);
  assert.match(html, /팝니다/);
  assert.match(html, /BTC 보내고 원화 받기/);
  assert.match(html, /보낼 원화/);
  assert.match(html, /판매자 프리미엄 \(%\)/);
  assert.match(html, /판매자가 기준 시세보다 2% 높은 단가로 팝니다/);
  assert.match(html, /구매자 자금 출처/);
  assert.match(html, /<select[^>]*id="buyer-funding-source"/);
  for (const fundingSource of [
    "기재하지 않음", "근로소득", "사업소득", "연금소득", "금융소득", "임대소득",
    "자산처분대금", "퇴직금", "상속·증여", "대출·차입금", "기존 보유자금", "기타소득",
  ]) {
    assert.match(html, new RegExp(`>${fundingSource}<`));
  }
  assert.match(html, /구매자가 제공한 정보이며, 거래 전에 서로 확인해 주세요/);
  assert.match(html, /입력값은 이 사이트에 저장되지 않습니다/);
  assert.match(html, /거래 전 조건 확인용 · 입금 및 비트코인 수령 증빙이 아닙니다/);
  assert.match(html, /거래 조건 공유/);
  assert.doesNotMatch(html, /거래 이미지 공유/);
  assert.match(html, /업비트 최근 체결가/);
  assert.match(html, /업비트 프리미엄/);
  assert.match(html, /시장 참고값/);
  assert.match(html, /CoinMarketCap 기준 글로벌 가격/);
  assert.match(html, /온체인 송금 수수료 별도/);
  assert.doesNotMatch(html, /당사자 입력|계산 미반영|자동으로 더하지|자동 반영하지/);
  assert.doesNotMatch(html, /계산 방향|원화 → sats|sats → 원화|회원가입|지갑 주소/);
});

test("keeps market data official and interaction failures recoverable", async () => {
  const [component, imageRenderer, shareTransport, api, css, packageJson] = await Promise.all([
    readFile(new URL("../app/components/P2PTradeTool.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-share-image.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/share-transport.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/market.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(api, /api\.upbit\.com\/v1\/ticker\?markets=KRW-BTC/);
  assert.match(api, /datalab-api\.upbit\.com\/api\/v1\/indicator\/premium\/assets\?symbols=BTC/);
  assert.match(api, /disparityRate/);
  assert.doesNotMatch(api, /Coinbase|coinbaseKrwGap|frankfurter/i);
  assert.match(component, /fetch\("\/api\/market", \{ cache: "no-store" \}\)/);
  assert.match(component, /직접 시세를 입력해 계산할 수도 있습니다/);
  assert.match(component, /navigator\.share/);
  assert.match(component, /navigator\.canShare/);
  assert.match(component, /URL\.createObjectURL/);
  assert.match(component, /manualReferencePrice/);
  assert.match(component, /setManualReferencePrice\(manualPriceNumber\)/);
  assert.match(component, /effectiveKoreaPremium/);
  assert.match(component, /buyer: "기재하지 않음"/);
  assert.match(component, /seller: "기재하지 않음"/);
  assert.match(component, /fundingSourceFieldLabel = "구매자 자금 출처"/);
  assert.doesNotMatch(component, /송금 계좌 명의|제3자|확인 전/);
  assert.match(component, /buyerFundingSource: fundingSource/);
  assert.match(component, /구매자 자금 출처: \$\{fundingSource\}/);
  assert.match(component, /구매자 제공 정보 · 상호 확인 필요/);
  assert.match(shareTransport, /files: \[file\]/);
  assert.match(component, /거래 조건 준비 중/);
  assert.match(component, /PNG 이미지를 저장했습니다/);
  assert.match(imageRenderer, /new File\(\[blob\]/);
  assert.match(imageRenderer, /type: "image\/png"/);
  assert.match(imageRenderer, /비트코인 기준 가격/);
  assert.match(imageRenderer, /조회 시각/);
  assert.match(imageRenderer, /referencePriceKrw/);
  assert.match(imageRenderer, /구매자 → 판매자/);
  assert.match(imageRenderer, /판매자 → 구매자/);
  assert.match(imageRenderer, /판매자 프리미엄/);
  assert.match(imageRenderer, /buyerFundingSource/);
  assert.match(imageRenderer, /구매자 자금 출처/);
  assert.match(imageRenderer, /구매자 제공 정보 · 상호 확인 필요/);
  assert.match(imageRenderer, /입금 및 비트코인 수령 증빙이 아닙니다/);
  assert.match(imageRenderer, /시장 참고 · 업비트 프리미엄/);
  assert.match(imageRenderer, /온체인 송금 수수료 별도/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /aria-invalid/);
  assert.doesNotMatch(component, /setInterval|feeSats/);
  assert.match(css, /\.role-options\s*\{[^}]*grid-template-columns:\s*repeat\(2/s);
  assert.match(css, /\.trade-form\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /\.field > span:first-child\s*\{/);
  assert.match(css, /\.input-with-unit\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.input-with-unit b\s*\{[^}]*border-left:/s);
  assert.match(css, /\.fund-source-field\s*\{[^}]*grid-column:\s*1 \/ -1/s);
  assert.match(css, /\.fund-source-field select\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.result-row dd\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.doesNotMatch(`${component}\n${imageRenderer}`, /당사자 입력|계산 미반영|자동으로 더하지|자동 반영하지/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("renders creator identity and Lightning support details", async () => {
  await Promise.all([
    access(new URL("../public/creator-logo.jpg", import.meta.url)),
    access(new URL("../public/lightning-support-qr.png", import.meta.url)),
  ]);
  await assert.rejects(access(new URL("../public/lightning-support-qr.jpg", import.meta.url)));
  const response = await render();
  const html = (await response.text()).replace(/<!-- -->/g, "");

  assert.ok(html.includes("\uC81C\uC791\u00B7\uD3B8\uCC2C"));
  assert.ok(html.includes("\uC5C4\uC9C0\uC655"));
  assert.match(html, /src="\/creator-logo\.jpg"/);
  assert.ok(html.includes("\uC5C4\uC9C0\uC655 \uB85C\uACE0"));
  assert.match(html, /https:\/\/x\.com\/thumbking0227/);
  assert.match(html, /https:\/\/www\.threads\.com\/@thumb\.ggul/);
  assert.ok(html.includes("\uB77C\uC774\uD2B8\uB2DD\uC73C\uB85C \uD6C4\uC6D0\uD558\uAE30"));
  assert.ok(html.includes("\uC774 \uACC4\uC0B0\uAE30\uAC00 \uB3C4\uC6C0\uC774 \uB418\uC5C8\uB2E4\uBA74 \uC9C0\uC18D\uC801\uC778 \uAC80\uC99D\uACFC \uB2E4\uC74C \uBC84\uC804 \uC81C\uC791\uC744 \uD6C4\uC6D0\uD574 \uC8FC\uC138\uC694."));
  assert.match(html, /href="\/lightning-support-qr\.png"/);
  assert.ok(html.includes("\uC5C4\uC9C0\uC655 \uB77C\uC774\uD2B8\uB2DD \uD6C4\uC6D0 QR"));
  assert.ok(html.includes("\uC5C4\uC9C0\uC655 \uB77C\uC774\uD2B8\uB2DD \uD6C4\uC6D0 \uC8FC\uC18C\uB97C \uB2F4\uC740 QR \uCF54\uB4DC"));
  assert.ok(html.includes("thumbking@oksu.su"));
  assert.ok(html.includes("\uB77C\uC774\uD2B8\uB2DD \uC8FC\uC18C \uBCF5\uC0AC"));
  assert.ok(html.includes("\uD6C4\uC6D0\uD558\uAE30 \uC804, \uB77C\uC774\uD2B8\uB2DD \uC9C0\uAC11\uC5D0 \uD45C\uC2DC\uB41C \uC218\uC2E0 \uC8FC\uC18C\uAC00 \uC544\uB798 \uC8FC\uC18C\uC640 \uAC19\uC740\uC9C0 \uD655\uC778\uD574 \uC8FC\uC138\uC694."));
});

test("ships an installable PWA with the tilted v2 icon set and no cached market data", async () => {
  const [manifestText, serviceWorker, registration, appIconSource, maskableSource, shareRenderer] = await Promise.all([
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PwaRegistration.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/icons/app-icon.svg", import.meta.url), "utf8"),
    readFile(new URL("../public/icons/app-icon-maskable.svg", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/trade-share-image.ts", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, "비트코인 P2P 계산기");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(
    manifest.icons.map(({ src, sizes, purpose }) => ({ src, sizes, purpose })),
    [
      { src: "/icons/icon-192-v2.png", sizes: "192x192", purpose: "any" },
      { src: "/icons/icon-512-v2.png", sizes: "512x512", purpose: "any" },
      { src: "/icons/icon-maskable-512-v2.png", sizes: "512x512", purpose: "maskable" },
    ],
  );
  const iconSizes = await Promise.all([
    readPngSize(new URL("../public/icons/icon-192-v2.png", import.meta.url)),
    readPngSize(new URL("../public/icons/icon-512-v2.png", import.meta.url)),
    readPngSize(new URL("../public/icons/icon-maskable-512-v2.png", import.meta.url)),
    readPngSize(new URL("../public/icons/apple-touch-icon-v2.png", import.meta.url)),
  ]);
  assert.deepEqual(iconSizes, [
    { width: 192, height: 192 },
    { width: 512, height: 512 },
    { width: 512, height: 512 },
    { width: 180, height: 180 },
  ]);

  assert.match(appIconSource, /rotate\(13\.88 256 256\)/);
  assert.match(maskableSource, /rotate\(13\.88 256 256\)/);
  assert.match(shareRenderer, /bitcoin\.org\/img\/icons\/logotop\.svg/);
  assert.match(shareRenderer, /new Path2D\(BITCOIN_MARK_PATH\)/);
  assert.doesNotMatch(shareRenderer, /fillText\("[B₿]"|fillRect\(-25, -78|fillRect\(9, -78/);

  assert.match(registration, /serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
  assert.match(serviceWorker, /bitcoin-p2p-check-v3/);
  assert.match(serviceWorker, /icon-192-v2\.png/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /fetch\(request, \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(serviceWorker, /cache\.put\([^\n]*api/i);

  const response = await render();
  const html = await response.text();
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /apple-touch-icon[^>]*href="\/icons\/apple-touch-icon-v2\.png"/);
  assert.match(html, /href="\/install\/"/);
  assert.match(html, /property="og:image" content="https:\/\/bitcoin-p2p-check\.thumbking\.workers\.dev\/og\.png"/);
  assert.doesNotMatch(html, /http:\/\/localhost:3000\/og\.png/);
});

test("renders shareable iPhone and Android home-screen installation guides", async () => {
  const [response, iphoneSize, androidSize, installSource] = await Promise.all([
    render("/install"),
    readPngSize(new URL("../public/install/iphone-guide-v1.png", import.meta.url)),
    readPngSize(new URL("../public/install/android-guide-v1.png", import.meta.url)),
    readFile(new URL("../app/install/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal(response.status, 200);
  const html = (await response.text()).replace(/<!-- -->/g, "");

  assert.match(html, /<h1[^>]*>홈 화면에 추가하기<\/h1>/);
  assert.match(html, /Safari에서 사이트를 엽니다/);
  assert.match(html, /웹 앱으로 열기/);
  assert.match(html, /설치 및 바로가기 만들기/);
  assert.match(html, /실시간 시세 확인에는 인터넷 연결이 필요합니다/);
  assert.match(html, /src="\/install\/iphone-guide-v1\.png"/);
  assert.match(html, /src="\/install\/android-guide-v1\.png"/);
  assert.ok(installSource.indexOf('<ol className="install-steps">') < installSource.indexOf('src="/install/iphone-guide-v1.png"'));
  assert.ok(installSource.lastIndexOf('<ol className="install-steps">') < installSource.indexOf('src="/install/android-guide-v1.png"'));
  assert.match(html, /href="\/"[^>]*>← 계산기로 돌아가기<\/a>/);
  assert.deepEqual(iphoneSize, { width: 1080, height: 1920 });
  assert.deepEqual(androidSize, { width: 1080, height: 1920 });
});

test("exports static pages and keeps only the market endpoint in the Worker", async () => {
  await Promise.all([
    access(new URL("../dist/client/index.html", import.meta.url)),
    access(new URL("../dist/client/install/index.html", import.meta.url)),
    access(new URL("../dist/client/404.html", import.meta.url)),
  ]);
  const [worker, nextConfig, wrangler, headers, css, home, packageJson] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../public/_headers", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(nextConfig, /output:\s*"export"/);
  assert.match(wrangler, /"directory":\s*"\.\/dist\/client"/);
  assert.match(wrangler, /"not_found_handling":\s*"404-page"/);
  assert.match(wrangler, /"run_worker_first":\s*\["\/api\/market",\s*"\/api\/market\/"\]/);
  assert.match(packageJson, /wrangler deploy --config wrangler\.jsonc/);
  assert.match(worker, /url\.pathname === "\/api\/market"/);
  assert.doesNotMatch(worker, /vinext\/server\/app-router-entry/);
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /Referrer-Policy:\s*no-referrer/);
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/);
  assert.match(headers, /X-Frame-Options:\s*DENY/);
  assert.match(headers, /Permissions-Policy:/);
  assert.match(css, /body\s*\{\s*min-width:\s*0/);
  assert.match(css, /\.refresh-button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(home, /<details className="reference-details">/);
  assert.doesNotMatch(home, /className="explanation"|className="source-note"/);
});
