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

test("renders the final 4:3 trade card directly from the lightweight share request", async () => {
  const transport = await source("../app/lib/share-transport.mjs");

  assert.match(transport, /TRADE_SHARE_REQUEST_TYPE/);
  assert.match(transport, /directlyTransformed\s*=\s*await runTradeImageTransform\(file, transform\)/);
  assert.match(transport, /if \(directlyTransformed\) return directlyTransformed/);

  const directTransformIndex = transport.indexOf("directlyTransformed = await runTradeImageTransform(file, transform)");
  const materializeIndex = transport.indexOf("file = await materializeShareFile(file)");
  assert.ok(directTransformIndex >= 0 && materializeIndex > directTransformIndex);
});

test("shares premium upstream work and caches the result independently", async () => {
  const marketWorker = await source("../worker/market.ts");

  assert.match(marketWorker, /PREMIUM_FRESH_CACHE_SECONDS\s*=\s*60/);
  assert.match(marketWorker, /PREMIUM_RETRY_BACKOFF_SECONDS\s*=\s*30/);
  assert.match(marketWorker, /pendingPremiumFetch/);
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
