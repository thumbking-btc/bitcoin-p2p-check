import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_WRANGLER_SECRET_LIST_BYTES,
  assertExactSecretAllowlist,
  getWorkerSecretProfile,
  parseWranglerSecretList,
  validateWranglerSecretList,
} from "../scripts/check-worker-secrets.mjs";
import {
  MAX_WRANGLER_VERSION_JSON_BYTES,
  parseLatestWorkerVersionId,
  parseWorkerVersionSecrets,
  validateWorkerVersionSecrets,
} from "../scripts/check-worker-version-secrets.mjs";

const PRODUCTION_ALLOWLIST = Object.freeze([
  Object.freeze({ name: "TRADE_RECORD_SIGNING_KEY", type: "secret_text" }),
]);
const VERSION_ID = "12345678-1234-4abc-8def-1234567890ab";

test("accepts only bounded Wrangler JSON with exact secret descriptors", () => {
  const raw = `[
    { "type": "secret_text", "name": "TRADE_RECORD_SIGNING_KEY" }
  ]\n`;
  const parsed = validateWranglerSecretList(raw, PRODUCTION_ALLOWLIST);

  assert.deepEqual(parsed, PRODUCTION_ALLOWLIST);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed[0]), true);
  assert.deepEqual(validateWranglerSecretList("[]\n", []), []);
});

test("rejects malformed, oversized, duplicate, or widened Wrangler secret lists", () => {
  const malformedLists = [
    "",
    "not-json",
    "{}",
    "[null]",
    '[{"name":"TRADE_RECORD_SIGNING_KEY","type":"secret_text","value":"must-not-appear"}]',
    '[{"name":"invalid-name","type":"secret_text"}]',
    '[{"name":"TRADE_RECORD_SIGNING_KEY","type":"secret_key"}]',
    '[{"name":"DUPLICATE","type":"secret_text"},{"name":"DUPLICATE","type":"secret_text"}]',
  ];
  for (const raw of malformedLists) {
    assert.throws(() => parseWranglerSecretList(raw), undefined, raw.slice(0, 80));
  }

  assert.throws(
    () => parseWranglerSecretList("[".padEnd(MAX_WRANGLER_SECRET_LIST_BYTES + 1, " ")),
    /허용 크기/u,
  );
  assert.throws(
    () => validateWranglerSecretList(
      '[{"name":"UNREVIEWED_SECRET","type":"secret_text"}]',
      PRODUCTION_ALLOWLIST,
    ),
    /exact allowlist/u,
  );
  assert.throws(
    () => validateWranglerSecretList("[]", PRODUCTION_ALLOWLIST),
    /exact allowlist/u,
  );
  assert.throws(
    () => assertExactSecretAllowlist([], [
      { name: "DUPLICATE", type: "secret_text" },
      { name: "DUPLICATE", type: "secret_text" },
    ]),
    /중복/u,
  );
});

test("checks the exact secret bindings on the latest and selected Worker versions", () => {
  const versionList = JSON.stringify([
    { id: "22345678-1234-4abc-8def-1234567890ab", number: 9 },
    { id: VERSION_ID, number: 12 },
    { id: "32345678-1234-4abc-8def-1234567890ab", number: 10 },
  ]);
  assert.equal(parseLatestWorkerVersionId(versionList), VERSION_ID);
  assert.equal(parseLatestWorkerVersionId("[]"), null);

  const detail = JSON.stringify({
    id: VERSION_ID,
    resources: {
      bindings: [
        { name: "ASSETS", type: "assets" },
        { name: "TRADE_RECORD_SIGNING_KEY", type: "secret_text" },
      ],
    },
  });
  assert.deepEqual(
    validateWorkerVersionSecrets(detail, VERSION_ID, PRODUCTION_ALLOWLIST),
    PRODUCTION_ALLOWLIST,
  );
  assert.deepEqual(validateWorkerVersionSecrets(
    JSON.stringify({ id: VERSION_ID, resources: { bindings: [] } }),
    VERSION_ID,
    [],
  ), []);

  assert.throws(
    () => parseLatestWorkerVersionId(JSON.stringify([
      { id: VERSION_ID, number: 1 },
      { id: "22345678-1234-4abc-8def-1234567890ab", number: 1 },
    ])),
    /중복/u,
  );
  assert.throws(
    () => parseWorkerVersionSecrets(detail, "22345678-1234-4abc-8def-1234567890ab"),
    /요청한 version/u,
  );
  assert.throws(
    () => validateWorkerVersionSecrets(
      JSON.stringify({
        id: VERSION_ID,
        resources: { bindings: [{ name: "UNREVIEWED_SECRET", type: "secret_text" }] },
      }),
      VERSION_ID,
      [],
    ),
    /exact allowlist/u,
  );
  assert.throws(
    () => parseWorkerVersionSecrets(JSON.stringify({
      id: VERSION_ID,
      resources: { bindings: [{ name: "SECRET_STORE", type: "secrets_store_secret" }] },
    }), VERSION_ID),
    /승인되지 않은 secret binding 유형/u,
  );
  assert.throws(
    () => parseLatestWorkerVersionId("[".padEnd(MAX_WRANGLER_VERSION_JSON_BYTES + 1, " ")),
    /허용 크기/u,
  );
});

test("wires exact staging deployment, version, and secret gates while production stays blocked", async () => {
  const [
    workflow,
    packageText,
    checker,
    versionChecker,
    stagingVersionChecker,
    stagingDeploymentChecker,
  ] = await Promise.all([
    readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/check-worker-secrets.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/check-worker-version-secrets.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/check-staging-version.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/check-staging-deployment.mjs", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(
    packageJson.scripts["secrets:check:production"],
    "node scripts/check-worker-secrets.mjs production",
  );
  assert.equal(
    packageJson.scripts["secrets:check:staging"],
    "node scripts/check-worker-secrets.mjs staging",
  );
  assert.equal(
    packageJson.scripts["secrets:check:preview"],
    "node scripts/check-worker-secrets.mjs preview",
  );
  assert.equal(
    packageJson.scripts["deploy:preview"],
    "npm run verify && npm run secrets:check:preview && wrangler deploy --config wrangler.preview.jsonc && npm run secrets:check:preview",
  );
  assert.equal(packageJson.devDependencies.wrangler, "4.125.0");
  assert.deepEqual(getWorkerSecretProfile("production"), {
    config: "wrangler.jsonc",
    workerName: "bitcoin-p2p-check",
    expectedSecrets: PRODUCTION_ALLOWLIST,
  });
  assert.deepEqual(getWorkerSecretProfile("staging"), {
    config: "wrangler.staging.jsonc",
    workerName: "bitcoin-p2p-check-staging",
    expectedSecrets: PRODUCTION_ALLOWLIST,
  });
  assert.deepEqual(getWorkerSecretProfile("preview"), {
    config: "wrangler.preview.jsonc",
    workerName: "bitcoin-p2p-check-preview",
    expectedSecrets: [],
  });
  assert.throws(() => getWorkerSecretProfile("toString"), /production, staging 또는 preview/u);
  assert.match(checker, /WRANGLER_VERSION = "4\.125\.0"/u);
  assert.match(checker, /"secret",\s*\r?\n\s*"list"[\s\S]*"--format",\s*\r?\n\s*"json"/u);
  assert.match(versionChecker, /WRANGLER_VERSION = "4\.125\.0"/u);
  assert.match(versionChecker, /"versions", "view"[\s\S]*"--json"/u);
  assert.match(stagingVersionChecker, /STAGING_WORKER_NAME = "bitcoin-p2p-check-staging"/u);
  assert.match(stagingVersionChecker, /"versions", "view", versionId/u);
  assert.match(stagingDeploymentChecker, /STAGING_WORKER_NAME = "bitcoin-p2p-check-staging"/u);
  assert.match(stagingDeploymentChecker, /"deployments", "status"/u);

  const stagingBaseline = workflow.indexOf("Capture the exact staging baseline before deployment");
  const stagingPre = workflow.indexOf("Verify staging remote secret allowlist before deployment");
  const stagingDeploy = workflow.indexOf("Deploy the verified isolated staging artifact atomically");
  const stagingConfig = workflow.indexOf("Verify the exact staging deployment configuration");
  const stagingSmoke = workflow.indexOf("Verify canonical staging identity and static behavior");
  const stagingStateful = workflow.indexOf("Verify the full staging trade-record lifecycle with synthetic data");
  const stagingFinal = workflow.indexOf("Detect a staging deployment or branch advance after smoke");
  assert.ok(stagingBaseline >= 0 && stagingBaseline < stagingPre && stagingPre < stagingDeploy);
  assert.ok(stagingDeploy < stagingConfig && stagingConfig < stagingSmoke);
  assert.ok(stagingSmoke < stagingStateful && stagingStateful < stagingFinal);
  const stagingBaselineSection = workflow.slice(stagingBaseline, stagingPre);
  const stagingPreSection = workflow.slice(stagingPre, stagingDeploy);
  const stagingDeploySection = workflow.slice(stagingDeploy, stagingConfig);
  const stagingConfigSection = workflow.slice(stagingConfig, stagingSmoke);
  const stagingFinalSection = workflow.slice(stagingFinal, workflow.indexOf("  deploy-production:"));
  for (const section of [
    stagingBaselineSection,
    stagingPreSection,
    stagingDeploySection,
    stagingConfigSection,
    stagingFinalSection,
  ]) {
    assert.match(section, /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/u);
    assert.match(section, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/u);
  }
  assert.match(stagingBaselineSection, /check-staging-deployment\.mjs capture/u);
  assert.match(stagingPreSection, /npm run secrets:check:staging/u);
  assert.match(
    stagingPreSection,
    /check-worker-version-secrets\.mjs staging "\$\{\{ steps\.staging-baseline\.outputs\.version_id \}\}"/u,
  );
  assert.match(
    stagingDeploySection,
    /check-staging-deployment\.mjs assert-single "\$\{\{ steps\.staging-baseline\.outputs\.version_id \}\}" "\$\{\{ steps\.staging-baseline\.outputs\.deployment_id \}\}"[\s\S]*check-worker-version-secrets\.mjs staging "\$\{\{ steps\.staging-baseline\.outputs\.version_id \}\}"[\s\S]*npm run deploy:staging:verified[\s\S]*record-staging-upload\.mjs --deploy[\s\S]*check-staging-deployment\.mjs capture-exact/u,
  );
  assert.match(stagingDeploySection, /CLOUDFLARE_STAGING_IDENTITY_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_STAGING_IDENTITY_TOKEN \}\}/u);
  assert.match(
    stagingConfigSection,
    /check-worker-version-secrets\.mjs staging "\$\{\{ steps\.staging-deployed\.outputs\.version_id \}\}"[\s\S]*check-staging-version\.mjs "\$\{\{ steps\.staging-deployed\.outputs\.version_id \}\}" "\$\{\{ github\.sha \}\}"/u,
  );
  assert.match(workflow.slice(stagingStateful, stagingFinal), /smoke-staging-trade-record\.mjs[\s\S]*STAGING_STATEFUL_TEST_APPROVED:\s*"true"/u);
  assert.match(
    stagingFinalSection,
    /git fetch --no-tags origin staging[\s\S]*check-staging-deployment\.mjs assert-single "\$\{\{ steps\.staging-deployed\.outputs\.version_id \}\}" "\$\{\{ steps\.staging-deployment\.outputs\.deployment_id \}\}"/u,
  );

  const productionJobIndex = workflow.indexOf("  deploy-production:");
  assert.ok(productionJobIndex >= 0);
  const productionJob = workflow.slice(productionJobIndex);
  assert.match(productionJob, /environment:\s*production/u);
  assert.match(productionJob, /Production deployment blocked/u);
  assert.match(productionJob, /exit 1/u);
  assert.doesNotMatch(productionJob, /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/u);
  assert.doesNotMatch(productionJob, /secrets:check:production|check-worker-version-secrets\.mjs production/u);
});
