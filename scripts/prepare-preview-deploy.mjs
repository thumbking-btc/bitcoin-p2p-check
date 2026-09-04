#!/usr/bin/env node
// Vite's RSC Worker exists only to prerender HTML. Never publish that Worker
// through Wrangler's implicit .wrangler/deploy/config.json redirect.
import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT = ".wrangler/deploy/static-preview/wrangler.json";
const REDIRECT = ".wrangler/deploy/config.json";
const REDIRECT_VALUE = { configPath: "static-preview/wrangler.json" };
const EXPECTED_KEYS = [
  "$schema", "name", "main", "compatibility_date", "compatibility_flags", "workers_dev",
  "preview_urls", "vars", "ratelimits", "version_metadata", "observability", "assets",
].sort();

export function assertPreviewBuildContext(environment) {
  if (!environment.WORKERS_CI) return;
  assert.equal(environment.WORKERS_CI, "1", "Unknown Workers Builds context");
  const branch = environment.WORKERS_CI_BRANCH;
  assert.ok(typeof branch === "string" && branch.length > 0, "Workers Builds must identify its branch");
  assert.ok(!["main", "staging", "refs/heads/main", "refs/heads/staging"].includes(branch.trim()), "Automatic main/staging publication is not an approved release path");
}

export function createPreviewDeployConfig(source) {
  assert.deepEqual(Object.keys(source).sort(), EXPECTED_KEYS, "Unexpected preview configuration capability");
  assert.equal(source.name, "bitcoin-p2p-check-preview");
  assert.equal(source.main, "./worker/preview-entry.ts");
  assert.deepEqual(source.vars, { DEPLOYMENT_ENV: "preview", TRADE_RECORDS_ENABLED: "false" });
  assert.equal(source.workers_dev, true);
  assert.equal(source.preview_urls, true);
  assert.equal(source.compatibility_date, "2026-08-25");
  assert.deepEqual(source.compatibility_flags, ["nodejs_compat", "global_fetch_strictly_public"]);
  assert.deepEqual(source.ratelimits, [{
    name: "LIGHTNING_REQUEST_RATE_LIMITER", namespace_id: "2026082592",
    simple: { limit: 12, period: 60 },
  }]);
  assert.deepEqual(source.version_metadata, { binding: "WORKER_VERSION" });
  assert.deepEqual(source.assets, {
    directory: "./dist/client", binding: "ASSETS", html_handling: "auto-trailing-slash",
    not_found_handling: "404-page", run_worker_first: true,
  });
  assert.deepEqual(source.observability, {
    enabled: false, head_sampling_rate: 0,
    logs: { enabled: false, head_sampling_rate: 0, invocation_logs: false, persist: false, destinations: [] },
    traces: { enabled: false, head_sampling_rate: 0, persist: false, destinations: [] },
  });
  return {
    ...source,
    $schema: "../../../node_modules/wrangler/config-schema.json",
    main: "../../../worker/preview-entry.ts",
    assets: { ...source.assets, directory: "../../../dist/client" },
  };
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function preparePreviewDeploy(root = ROOT, { check = false, environment = process.env } = {}) {
  assertPreviewBuildContext(environment);
  const source = JSON.parse(await readFile(path.join(root, "wrangler.preview.jsonc"), "utf8"));
  const expected = createPreviewDeployConfig(source);
  const target = path.join(root, OUTPUT);
  const redirect = path.join(root, REDIRECT);
  if (!check) {
    // Publish the pointer last so a partial build cannot point at an incomplete config.
    await atomicJson(target, expected);
    await atomicJson(redirect, REDIRECT_VALUE);
  }
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), expected, "Generated preview configuration drifted");
  assert.deepEqual(JSON.parse(await readFile(redirect, "utf8")), REDIRECT_VALUE, "Wrangler points at the build-only RSC Worker");
  assert.equal(path.resolve(path.dirname(target), expected.main), path.join(root, "worker/preview-entry.ts"));
  assert.equal(path.resolve(path.dirname(target), expected.assets.directory), path.join(root, "dist/client"));
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preparePreviewDeploy(ROOT, { check: process.argv.includes("--check") }).then(() => {
    console.log("Default Wrangler target verified: preview-entry.ts + dist/client; records disabled; no production bindings.");
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
