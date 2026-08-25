import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("uploads the exact Worker bundle from Wrangler's hidden output directory", async () => {
  const workflow = await readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
  const step = workflow.match(
    / {6}- name: Preserve the exact verified Worker bundle[\s\S]*?(?=\r?\n\r?\n {2}deploy-production:)/u,
  )?.[0] ?? "";

  assert.ok(step, "verified Worker artifact upload step is missing");
  assert.match(step, /uses: actions\/upload-artifact@[0-9a-f]{40}\b/u);
  assert.match(step, /include-hidden-files:\s*true\b/u);
  assert.match(step, /if-no-files-found:\s*error\b/u);

  const pathBlock = step.match(/path:\s*\|\r?\n((?: {12}[^\r\n]+\r?\n?)+)/u)?.[1] ?? "";
  const artifactPaths = pathBlock
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(artifactPaths, [
    ".wrangler/dry-run/production/index.js",
    ".wrangler/dry-run/production/index.js.map",
  ]);
});

test("fails closed on account telemetry until a redacting export pipeline is verified", async () => {
  for (const path of ["../wrangler.jsonc", "../wrangler.preview.jsonc"]) {
    const config = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
    assert.equal(config.observability?.enabled, false, `${path}: account observability must remain disabled`);
    assert.equal(config.observability?.head_sampling_rate, 0, `${path}: global sampling must remain zero`);
    assert.equal(config.observability?.logs?.enabled, false, `${path}: Workers Logs must remain disabled`);
    assert.equal(config.observability?.logs?.head_sampling_rate, 0, `${path}: log sampling must remain zero`);
    assert.equal(config.observability?.logs?.persist, false, `${path}: custom logs must not be persisted`);
    assert.equal(config.observability?.logs?.invocation_logs, false, `${path}: invocation URLs must not be persisted`);
    assert.deepEqual(config.observability?.logs?.destinations, [], `${path}: log export destinations must remain empty`);
    assert.equal(config.observability?.traces?.enabled, false, `${path}: automatic URL traces must be disabled`);
    assert.equal(config.observability?.traces?.head_sampling_rate, 0, `${path}: trace sampling must remain zero`);
    assert.equal(config.observability?.traces?.persist, false, `${path}: automatic URL traces must not be persisted`);
    assert.deepEqual(config.observability?.traces?.destinations, [], `${path}: trace export destinations must remain empty`);
  }
});
