import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("routes receive-info requests through the existing market Worker path", async () => {
  const [wrangler, worker, market] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/market.ts", import.meta.url), "utf8"),
  ]);

  for (const route of ["/api/market", "/api/market/"]) {
    assert.ok(wrangler.includes(`"${route}"`), `missing run_worker_first route: ${route}`);
  }
  assert.doesNotMatch(wrangler, /"run_worker_first"\s*:\s*true/);

  assert.match(worker, /url\.pathname === "\/api\/market"/);
  assert.match(market, /receiveMode === "lightning-address"/);
  assert.match(market, /handleLightningAddressRequest\(request\)/);
  assert.match(market, /receiveMode === "lightning-pay"/);
  assert.match(market, /handleLightningPayRequest\(request\)/);
});
