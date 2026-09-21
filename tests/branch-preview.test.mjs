import assert from "node:assert/strict";
import test from "node:test";

import { extractCloudflareCommitPreviewUrl } from "../scripts/check-branch-preview.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const VALID_URL = "https://8fdf1daf-bitcoin-p2p-check.thumbking-btc.workers.dev";

function cloudflareComment({ sha = SHA.slice(0, 8), url = VALID_URL } = {}) {
  return {
    user: { login: "cloudflare-workers-and-pages[bot]" },
    body: `| Status | Name | Latest Commit | Preview URL |\n| -|-|-|-|\n| ✅ | bitcoin-p2p-check | ${sha} | <a href='${url}'>Commit Preview URL</a> |`,
  };
}

test("selects only the Cloudflare commit preview for the exact PR head abbreviation", () => {
  const comments = [
    cloudflareComment({ sha: "deadbeef", url: "https://11111111-bitcoin-p2p-check.thumbking-btc.workers.dev" }),
    {
      user: { login: "someone-else" },
      body: `| bitcoin-p2p-check | ${SHA.slice(0, 8)} | <a href='https://spoof-bitcoin-p2p-check.thumbking-btc.workers.dev'>Commit Preview URL</a> |`,
    },
    cloudflareComment(),
  ];

  assert.equal(extractCloudflareCommitPreviewUrl(comments, SHA), VALID_URL);
});

test("returns null until Cloudflare posts a preview for the current commit", () => {
  assert.equal(extractCloudflareCommitPreviewUrl([cloudflareComment({ sha: "deadbeef" })], SHA), null);
});

test("fails closed when the matching Cloudflare row contains an untrusted preview host", () => {
  assert.throws(
    () => extractCloudflareCommitPreviewUrl([
      cloudflareComment({ url: "https://8fdf1daf-bitcoin-p2p-check.example.com" }),
    ], SHA),
    /허용되지 않은 Cloudflare 커밋 프리뷰 URL/u,
  );
});

test("rejects malformed commit identities before inspecting comments", () => {
  assert.throws(
    () => extractCloudflareCommitPreviewUrl([], "01234567"),
    /Git 커밋 SHA가 올바르지 않습니다/u,
  );
});
