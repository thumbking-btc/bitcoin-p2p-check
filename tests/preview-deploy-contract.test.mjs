import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPreviewBuildContext, createPreviewDeployConfig, preparePreviewDeploy } from "../scripts/prepare-preview-deploy.mjs";

const source = JSON.parse(await readFile(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8"));

test("implicit Wrangler deployment selects the real static handler, never the prerender Worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p2p-preview-contract-"));
  try {
    await writeFile(path.join(root, "wrangler.preview.jsonc"), JSON.stringify(source));
    await mkdir(path.join(root, ".wrangler/deploy"), { recursive: true });
    await writeFile(path.join(root, ".wrangler/deploy/config.json"), '{"configPath":"../../dist/rsc/wrangler.json"}');
    await preparePreviewDeploy(root, { environment: {} });
    const config = await preparePreviewDeploy(root, { check: true, environment: {} });
    assert.equal(config.main, "../../../worker/preview-entry.ts");
    assert.equal(config.assets.directory, "../../../dist/client");
    assert.equal(config.vars.TRADE_RECORDS_ENABLED, "false");
    await writeFile(path.join(root, ".wrangler/deploy/config.json"), '{"configPath":"../../dist/rsc/wrangler.json"}');
    await assert.rejects(preparePreviewDeploy(root, { check: true, environment: {} }), /Wrangler points/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview packaging rejects expanded capabilities and production configuration", () => {
  for (const mutate of [
    (value) => { value.vars.DEPLOYMENT_ENV = "production"; },
    (value) => { value.vars.TRADE_RECORDS_ENABLED = "true"; },
    (value) => { value.kv_namespaces = []; },
    (value) => { value.services = []; },
    (value) => { value.secrets = { required: ["TRADE_RECORD_SIGNING_KEY"] }; },
    (value) => { value.main = "./worker/prerender.ts"; },
    (value) => { value.assets.directory = "./dist/rsc"; },
    (value) => { value.assets.run_worker_first = false; },
    (value) => { value.observability.enabled = true; },
  ]) {
    const modified = structuredClone(source);
    mutate(modified);
    assert.throws(() => createPreviewDeployConfig(modified));
  }
});

test("automatic release branches fail closed while ordinary local preview builds remain usable", () => {
  assert.doesNotThrow(() => assertPreviewBuildContext({}));
  assert.doesNotThrow(() => assertPreviewBuildContext({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "review/ux-safety-20260903" }));
  for (const branch of [undefined, "", "main", "staging"]) {
    assert.throws(() => assertPreviewBuildContext({ WORKERS_CI: "1", WORKERS_CI_BRANCH: branch }));
  }
});

test("postbuild validates assets and CSP before replacing the Vite redirect", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.scripts.postbuild, /generate-csp-headers\.mjs && node scripts\/check-static-assets\.mjs && node scripts\/prepare-preview-deploy\.mjs$/u);
  const entry = await readFile(new URL("../worker/preview-entry.ts", import.meta.url), "utf8");
  assert.match(entry, /export \{ default \} from "\.\/index"/u);
  assert.doesNotMatch(entry, /export \*|export \{ TradeRecordState|vinext\/server/u);
});
