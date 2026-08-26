import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_STAGING_DEPLOYMENT_JSON_BYTES,
  parseStagingDeployment,
  parseStagingDeploymentState,
  requireSingleStagingDeployment,
  requireSingleStagingVersion,
} from "../scripts/check-staging-deployment.mjs";

const DEPLOYMENT_ID = "92345678-1234-4abc-8def-1234567890ab";
const VERSION_ID = "12345678-1234-4abc-8def-1234567890ab";
const OTHER_VERSION_ID = "22345678-1234-4abc-8def-1234567890ab";

function deployment(versions, overrides = {}) {
  return JSON.stringify({
    id: DEPLOYMENT_ID,
    source: "wrangler",
    strategy: "percentage",
    versions,
    ...overrides,
  });
}

test("accepts and pins only an exact single staging version at 100 percent", () => {
  const raw = deployment([{ version_id: VERSION_ID, percentage: 100 }]);
  assert.deepEqual(parseStagingDeployment(raw), [
    { versionId: VERSION_ID, percentage: 100 },
  ]);
  assert.deepEqual(parseStagingDeploymentState(raw), {
    deploymentId: DEPLOYMENT_ID,
    versions: [{ versionId: VERSION_ID, percentage: 100 }],
  });
  assert.deepEqual(requireSingleStagingDeployment(raw, VERSION_ID, DEPLOYMENT_ID), {
    deploymentId: DEPLOYMENT_ID,
    versionId: VERSION_ID,
  });
  assert.equal(requireSingleStagingVersion(raw), VERSION_ID);
  assert.equal(requireSingleStagingVersion(raw, VERSION_ID), VERSION_ID);
});

test("rejects traffic splits, zero-percent candidates, and the wrong promoted version", () => {
  const split = deployment([
    { version_id: VERSION_ID, percentage: 50 },
    { version_id: OTHER_VERSION_ID, percentage: 50 },
  ]);
  assert.throws(() => requireSingleStagingVersion(split), /단일 version 100%/u);
  assert.throws(
    () => requireSingleStagingVersion(
      deployment([
        { version_id: VERSION_ID, percentage: 100 },
        { version_id: OTHER_VERSION_ID, percentage: 0 },
      ]),
    ),
    /단일 version 100%/u,
  );
  assert.throws(
    () => requireSingleStagingVersion(
      deployment([{ version_id: VERSION_ID, percentage: 100 }]),
      OTHER_VERSION_ID,
    ),
    /고정한 version/u,
  );
  assert.throws(
    () => requireSingleStagingDeployment(
      deployment([{ version_id: VERSION_ID, percentage: 100 }]),
      VERSION_ID,
      "82345678-1234-4abc-8def-1234567890ab",
    ),
    /deployment ID/u,
  );
});

test("rejects malformed, duplicated, inconsistent, or widened deployment output", () => {
  for (const raw of [
    "",
    "not-json",
    "[]",
    "{}",
    deployment([], {}),
    deployment([{ version_id: VERSION_ID, percentage: 100 }], { strategy: "gradual" }),
    deployment([{ version_id: VERSION_ID, percentage: 99 }]),
    deployment([{ version_id: VERSION_ID, percentage: Number.NaN }]),
    deployment([
      { version_id: VERSION_ID, percentage: 50 },
      { version_id: VERSION_ID, percentage: 50 },
    ]),
    deployment([{ version_id: "invalid", percentage: 100 }]),
    deployment([{ version_id: VERSION_ID, percentage: 100, unexpected: true }]),
  ]) {
    assert.throws(() => parseStagingDeployment(raw), undefined, raw.slice(0, 120));
  }

  assert.throws(
    () => parseStagingDeployment("{".padEnd(MAX_STAGING_DEPLOYMENT_JSON_BYTES + 1, " ")),
    /허용 크기/u,
  );
});

test("pins a staging-only deployments status command with bounded output", async () => {
  const checker = await readFile(
    new URL("../scripts/check-staging-deployment.mjs", import.meta.url),
    "utf8",
  );
  assert.match(checker, /WRANGLER_VERSION = "4\.125\.0"/u);
  assert.match(checker, /"deployments", "status"/u);
  assert.match(checker, /"--config", STAGING_CONFIG_PATH/u);
  assert.match(checker, /"--name", STAGING_WORKER_NAME/u);
  assert.match(checker, /maxBuffer: MAX_STAGING_DEPLOYMENT_JSON_BYTES/u);
  assert.match(checker, /timeout: 30_000/u);
  assert.match(checker, /mode === "capture-exact"/u);
  assert.match(checker, /version_id=\$\{deployment\.versionId\}\\ndeployment_id=\$\{deployment\.deploymentId\}/u);
});
