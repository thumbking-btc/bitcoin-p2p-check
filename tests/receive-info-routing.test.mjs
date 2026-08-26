import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("routes market and signed-record APIs through the Worker", async () => {
  const [wrangler, worker, market, tradeRecord] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/market.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/trade-record.ts", import.meta.url), "utf8"),
  ]);

  assert.match(wrangler, /"binding"\s*:\s*"ASSETS"/);
  assert.match(wrangler, /"run_worker_first"\s*:\s*true/);

  assert.match(worker, /url\.pathname === "\/api\/market"/);
  assert.match(worker, /isTradeRecordApiPath\(url\.pathname\)/);
  assert.match(worker, /handleTradeRecordRequest\(request, environment, \{[\s\S]*stateNamespace: context\.exports\.TradeRecordState,[\s\S]*\}\)/);
  assert.match(worker, /staticAssetResponse\(request, environment\)/);
  assert.match(market, /receiveMode === "lightning-address"/);
  assert.match(market, /handleLightningAddressRequest\(request, environment\)/);
  assert.match(market, /receiveMode === "lightning-pay"/);
  assert.match(market, /handleLightningPayRequest\(request, environment\)/);
  assert.match(tradeRecord, /pathname === "\/api\/trade-record"/);
  assert.match(tradeRecord, /crypto\.subtle\.sign/);
  assert.match(tradeRecord, /TRADE_RECORDS/);
  assert.match(tradeRecord, /recordTtl\(signed, createdAtMs\)/);
});
