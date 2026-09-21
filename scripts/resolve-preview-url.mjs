#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { extractCloudflareCommitPreviewUrl } from "./check-branch-preview.mjs";

const repository = process.env.PREVIEW_GITHUB_REPOSITORY ?? "";
const sha = process.env.PREVIEW_COMMIT_SHA ?? "";
const pr = process.env.PREVIEW_PR_NUMBER ?? "";
const token = process.env.PREVIEW_GITHUB_TOKEN ?? "";
assert.equal(repository, "thumbking-btc/bitcoin-p2p-check");
assert.match(sha, /^[0-9a-f]{40}$/u);
assert.match(pr, /^[1-9]\d*$/u);
assert.ok(token, "A read-only GitHub token is required to resolve the commit preview");

const deadline = Date.now() + 300_000;
let baseUrl;
while (Date.now() < deadline) {
  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${pr}/comments?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, "Cannot read preview identity from GitHub");
  const comments = await response.json();
  // Limit extraction to the matching row, not another Worker URL in the same comment.
  const matchingRows = comments.map((comment) => ({
    ...comment,
    body: typeof comment.body === "string" ? comment.body.split("\n").filter((line) =>
      line.includes(`| bitcoin-p2p-check | ${sha.slice(0, 8)} |`) && line.includes("Commit Preview URL"),
    ).join("\n") : "",
  }));
  baseUrl = extractCloudflareCommitPreviewUrl(matchingRows, sha);
  if (baseUrl) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
assert.ok(baseUrl, "Cloudflare has not published a preview for this exact commit");
assert.match(baseUrl, /^https:\/\/[0-9a-f]{8}-bitcoin-p2p-check\.thumbking-btc\.workers\.dev$/u);
const response = await fetch(`${baseUrl}/api/version`, {
  redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
});
assert.equal(response.status, 200);
const version = await response.json();
assert.equal(version.deploymentEnvironment, "preview");
assert.equal(version.workerVersion?.id?.slice(0, 8), new URL(baseUrl).hostname.slice(0, 8));
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `preview_url=${baseUrl}\n`);
console.log(`Resolved exact ${sha} preview: ${baseUrl} (${version.workerVersion.id})`);
