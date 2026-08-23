import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("routes receive-info APIs through the Worker before static assets", async () => {
  const [wrangler, worker] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  for (const route of [
    "/api/market",
    "/api/market/",
    "/api/lightning-address",
    "/api/lightning-address/",
    "/api/lightning-pay",
    "/api/lightning-pay/",
  ]) assert.ok(wrangler.includes(`"${route}"`), `missing run_worker_first route: ${route}`);

  assert.match(worker, /url\.pathname === "\/api\/lightning-address"/);
  assert.match(worker, /url\.pathname === "\/api\/lightning-pay"/);
});
