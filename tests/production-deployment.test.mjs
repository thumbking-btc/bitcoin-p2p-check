import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProductionDeployment,
  requireSingleProductionVersion,
} from "../scripts/check-production-deployment.mjs";

const currentVersionId = "12345678-1234-4abc-8def-1234567890ab";
const candidateVersionId = "87654321-4321-4abc-8def-abcdef123456";

function deployment(versions) {
  return JSON.stringify({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    source: "wrangler",
    strategy: "percentage",
    versions,
  });
}

test("parses and pins only a single 100% production version", () => {
  const raw = deployment([{ version_id: currentVersionId, percentage: 100 }]);
  assert.deepEqual(parseProductionDeployment(raw), [
    { versionId: currentVersionId, percentage: 100 },
  ]);
  assert.equal(requireSingleProductionVersion(raw), currentVersionId);
  assert.equal(requireSingleProductionVersion(raw, currentVersionId), currentVersionId);
  assert.throws(() => requireSingleProductionVersion(raw, candidateVersionId), /고정한 version/u);
});

test("rejects malformed, duplicate, incomplete, and over-broad deployments", () => {
  assert.throws(() => parseProductionDeployment("{}"), /형식/u);
  assert.throws(() => parseProductionDeployment("not json"), /유효한 JSON/u);
  assert.throws(
    () => parseProductionDeployment(deployment([
      { version_id: currentVersionId, percentage: 50 },
      { version_id: currentVersionId, percentage: 50 },
    ])),
    /중복/u,
  );
  assert.throws(
    () => parseProductionDeployment(deployment([
      { version_id: currentVersionId, percentage: 99 },
    ])),
    /합계/u,
  );
  assert.throws(
    () => requireSingleProductionVersion(deployment([
      { version_id: currentVersionId, percentage: 100 },
      { version_id: candidateVersionId, percentage: 0 },
    ])),
    /단일 version 100%/u,
  );
});
