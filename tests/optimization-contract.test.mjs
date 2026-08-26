import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("keeps the PWA cache tied to the app release and precaches rendered assets", async () => {
  const [registration, serviceWorker] = await Promise.all([
    source("../app/components/PwaRegistration.tsx"),
    source("../public/sw.js"),
  ]);

  assert.match(registration, /APP_VERSION/);
  assert.match(registration, /\/sw\.js\?v=/);
  assert.match(registration, /updateViaCache:\s*"none"/);

  assert.match(serviceWorker, /WORKER_VERSION/);
  assert.match(serviceWorker, /bitcoin-p2p-check-precache-\$\{WORKER_VERSION\}/);
  assert.match(serviceWorker, /bitcoin-p2p-check-runtime-\$\{WORKER_VERSION\}/);
  assert.match(serviceWorker, /referencedSameOriginAssets/);
  assert.match(serviceWorker, /precachePath/);
  assert.match(serviceWorker, /MAX_RUNTIME_ENTRIES\s*=\s*40/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /fetch\(request, \{ cache: "no-store" \}\)/);
});

test("keeps compact, balanced spacing around the reference cards", async () => {
  const [home, css] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/globals.css"),
  ]);

  assert.match(home, /site-main site-main-with-references/);
  assert.equal((home.match(/className="reference-details"/g) ?? []).length, 2);
  assert.doesNotMatch(home, /style=\{/);
  assert.match(css, /\.site-main-with-references\s*\{[^}]*padding-bottom:\s*16px/s);
  assert.match(css, /\.reference-stack\s*\{[^}]*gap:\s*16px;[^}]*margin-top:\s*16px/s);
  assert.match(css, /\.reference-stack > \.reference-details\s*\{[^}]*margin-top:\s*0/s);
});

test("keeps Samsung Internet on the tested Android Chrome install guide", async () => {
  const installCta = await source("../app/components/InstallCta.tsx");

  assert.match(installCta, /SamsungBrowser/);
  assert.match(installCta, /if \(isSamsungInternet\(\)\)/);
  assert.match(installCta, /event\.preventDefault\(\)/);
  assert.match(installCta, /setDeferredPrompt\(null\)/);
  assert.match(installCta, /setMode\("android"\)/);
  assert.match(installCta, /Chrome으로 연 뒤 브라우저 메뉴에서 설치/);
});

test("keeps the Upbit live path lightweight and realtime only", async () => {
  const calculator = await source("../app/components/P2PTradeTool.tsx");

  assert.match(calculator, /type:\s*"trade"/);
  assert.match(calculator, /is_only_realtime:\s*true/);
  assert.match(calculator, /format:\s*"SIMPLE"/);
  assert.match(calculator, /trade\.cd/);
  assert.match(calculator, /trade\.tp/);
  assert.match(calculator, /trade\.ttms/);
  assert.doesNotMatch(calculator, /type:\s*"ticker",\s*codes/);
});

test("does not rerender the hidden recruitment editor for live price-only changes", async () => {
  const [calculator, recruitment] = await Promise.all([
    source("../app/components/P2PTradeTool.tsx"),
    source("../app/components/TradeRecruitmentTool.tsx"),
  ]);

  assert.match(calculator, /active=\{outputMode === "recruitment"\}/);
  assert.match(recruitment, /memo\(TradeRecruitmentToolComponent, recruitmentPropsEqual\)/);
  assert.match(recruitment, /if \(!next\.active\) return true/);
});

test("materializes the final 4:3 trade card without DOM transform bridges", async () => {
  const transport = await source("../app/lib/share-transport.mjs");

  assert.match(transport, /TRADE_SHARE_REQUEST_TYPE/);
  assert.match(transport, /await import\("\.\/trade-share-image"\)/);
  assert.match(transport, /materializeTradeShareImage\(file\)/);
  assert.match(transport, /return normalizePngFilename\(file\)/);
  assert.doesNotMatch(transport, /runTradeImageTransform|__p2pTransformTradeShareFile|dataset|querySelector|document\./);

  const materializeIndex = transport.indexOf("file = await materializeShareFile(file)");
  const normalizeIndex = transport.indexOf("return normalizePngFilename(file)");
  assert.ok(materializeIndex >= 0 && normalizeIndex > materializeIndex);
});

test("caches premium work without request-scoped module globals", async () => {
  const marketWorker = await source("../worker/market.ts");

  assert.match(marketWorker, /PREMIUM_FRESH_CACHE_SECONDS\s*=\s*60/);
  assert.match(marketWorker, /PREMIUM_RETRY_BACKOFF_SECONDS\s*=\s*30/);
  assert.doesNotMatch(marketWorker, /let\s+pendingPremiumFetch/);
  assert.doesNotMatch(marketWorker, /let\s+pendingSnapshot/);
  assert.match(marketWorker, /readBoundedJson\(\s*response,\s*MAX_UPSTREAM_JSON_BYTES,\s*controller\.signal\s*\)/);
  assert.match(marketWorker, /fresh-premium/);
  assert.match(marketWorker, /premium-backoff/);
  assert.match(marketWorker, /resolvePremium/);
});

test("hydrates only the interactive support address control", async () => {
  const [panel, copyControl] = await Promise.all([
    source("../app/components/SupportPanel.tsx"),
    source("../app/components/SupportAddressCopy.tsx"),
  ]);

  assert.doesNotMatch(panel, /^"use client";/);
  assert.match(panel, /SupportAddressCopy/);
  assert.match(copyControl, /^"use client";/);
});
