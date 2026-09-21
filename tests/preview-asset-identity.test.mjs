import assert from "node:assert/strict";
import test from "node:test";
import { assertAssetIdentity, validatePreviewOrigin } from "../scripts/check-preview-assets.mjs";

const assetPath = "/_next/static/example.css";
const body = Buffer.from(".role-options{display:grid}");
const response = () => ({
  status: 200, body,
  headers: new Headers({
    "content-type": "text/css; charset=utf-8", "x-content-type-options": "nosniff",
    "cache-control": "public, max-age=31536000, immutable",
  }),
});
test("deployed asset verification rejects missing or changed bytes even at the same URL", () => {
  assert.equal(assertAssetIdentity(assetPath, body, response()).bytes, body.length);
  for (const mutate of [
    (value) => { value.status = 404; },
    (value) => { value.body = Buffer.from(".role-options{display:block}"); },
    (value) => { value.body = Buffer.alloc(0); },
    (value) => { value.headers.set("content-type", "text/html"); },
    (value) => { value.headers.delete("x-content-type-options"); },
    (value) => { value.headers.set("cache-control", "public, max-age=3600"); },
  ]) {
    const changed = response();
    mutate(changed);
    assert.throws(() => assertAssetIdentity(assetPath, body, changed));
  }
});
test("asset checks cannot target production, mutable aliases, or unrelated origins", () => {
  assert.equal(validatePreviewOrigin("https://1234abcd-bitcoin-p2p-check.thumbking-btc.workers.dev"), "https://1234abcd-bitcoin-p2p-check.thumbking-btc.workers.dev");
  for (const origin of [
    "https://bitcoin-p2p-check.thumbking-btc.workers.dev", "https://staging-bitcoin-p2p-check.thumbking-btc.workers.dev",
    "https://1234abcd-bitcoin-p2p-check.thumbking-btc.workers.dev.evil.example", "https://example.com",
  ]) assert.throws(() => validatePreviewOrigin(origin));
});
