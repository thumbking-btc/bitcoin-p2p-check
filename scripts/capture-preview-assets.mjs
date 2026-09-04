#!/usr/bin/env node
// Read-only evidence of exactly the asset bytes referenced by the deployed HTML.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractReferencedAssets } from "./smoke-deployment.mjs";
const baseUrl = process.env.PREVIEW_BASE_URL ?? "";
assert.match(baseUrl, /^https:\/\/[0-9a-f]{8}-bitcoin-p2p-check\.thumbking-btc\.workers\.dev$/u);
const directory = "render-diagnostics";
await mkdir(`${directory}/assets`, { recursive: true });
async function read(url) {
  const response = await fetch(url, { redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(20_000) });
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2_000_000) { void reader.cancel().catch(() => {}); throw new Error("Oversized asset"); }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks);
  return { body, url, status: response.status, headers: Object.fromEntries(response.headers), sha256: createHash("sha256").update(body).digest("hex") };
}
const root = await read(`${baseUrl}/`);
await writeFile(`${directory}/root.html`, root.body);
const assets = extractReferencedAssets(root.body.toString("utf8"), `${baseUrl}/`)
  .filter(({ mediaType }) => ["css", "javascript"].includes(mediaType));
assert.ok(assets.length > 0 && assets.length <= 32);
const report = [{ ...root, body: undefined }];
for (const asset of assets) {
  assert.equal(new URL(asset.url).origin, baseUrl);
  const result = await read(asset.url);
  await writeFile(`${directory}/assets/${path.basename(asset.path)}`, result.body);
  report.push({ ...result, body: undefined });
}
await writeFile(`${directory}/http.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.map(({ url, status, sha256 }) => ({ url, status, sha256 })), null, 2));
