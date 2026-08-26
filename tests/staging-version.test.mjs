import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_STAGING_VERSION_JSON_BYTES,
  STAGING_WORKER_NAME,
  validateExactStagingVersion,
} from "../scripts/check-staging-version.mjs";

const VERSION_ID = "12345678-1234-4abc-8def-1234567890ab";
const OTHER_VERSION_ID = "22345678-1234-4abc-8def-1234567890ab";
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT_SHA = "1123456789abcdef0123456789abcdef01234567";

function exactVersion() {
  return {
    id: VERSION_ID,
    number: 7,
    metadata: {
      created_on: "2026-08-26T00:00:00.000Z",
      has_preview: false,
      source: "wrangler",
    },
    annotations: {
      "workers/message": "staging candidate",
      "workers/tag": COMMIT_SHA,
      "workers/triggered_by": "upload",
    },
    resources: {
      script: { handlers: ["fetch"] },
      script_runtime: {
        assets: true,
        compatibility_date: "2026-08-25",
        compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
        exports: { TradeRecordState: { type: "durable-object", storage: "sqlite" } },
        usage_model: "standard",
      },
      bindings: [
        { name: "WORKER_VERSION", type: "version_metadata" },
        { name: "TRADE_RECORDS_ENABLED", text: "true", type: "plain_text" },
        { name: "TRADE_RECORD_SIGNING_KEY", type: "secret_text" },
        {
          name: "TRADE_RECORD_CREATE_RATE_LIMITER",
          namespace_id: "2026082692",
          simple: { limit: 6, period: 60 },
          type: "ratelimit",
        },
        {
          name: "TRADE_RECORD_READ_RATE_LIMITER",
          namespace_id: "2026082693",
          simple: { limit: 120, period: 60 },
          type: "ratelimit",
        },
        {
          name: "LIGHTNING_REQUEST_RATE_LIMITER",
          namespace_id: "2026082591",
          simple: { limit: 12, period: 60 },
          type: "ratelimit",
        },
        { name: "DEPLOYMENT_ENV", text: "staging", type: "plain_text" },
        { name: "ASSETS", type: "assets" },
      ],
    },
  };
}

function validate(version = exactVersion(), options) {
  return validateExactStagingVersion(
    JSON.stringify(version),
    STAGING_WORKER_NAME,
    VERSION_ID,
    COMMIT_SHA,
    options,
  );
}

test("accepts only the exact staging Worker version identity, runtime, and binding allowlist", () => {
  const validated = validate();

  assert.deepEqual(validated, {
    workerName: STAGING_WORKER_NAME,
    versionId: VERSION_ID,
    source: "wrangler",
    tag: COMMIT_SHA,
    compatibilityDate: "2026-08-25",
    compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
    bindings: [
      { name: "ASSETS", type: "assets" },
      { name: "DEPLOYMENT_ENV", text: "staging", type: "plain_text" },
      {
        name: "LIGHTNING_REQUEST_RATE_LIMITER",
        namespace_id: "2026082591",
        simple: { limit: 12, period: 60 },
        type: "ratelimit",
      },
      {
        name: "TRADE_RECORD_CREATE_RATE_LIMITER",
        namespace_id: "2026082692",
        simple: { limit: 6, period: 60 },
        type: "ratelimit",
      },
      {
        name: "TRADE_RECORD_READ_RATE_LIMITER",
        namespace_id: "2026082693",
        simple: { limit: 120, period: 60 },
        type: "ratelimit",
      },
      { name: "TRADE_RECORD_SIGNING_KEY", type: "secret_text" },
      { name: "TRADE_RECORDS_ENABLED", text: "true", type: "plain_text" },
      { name: "WORKER_VERSION", type: "version_metadata" },
    ],
  });
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.bindings), true);
});

test("rejects a wrong Worker target, version ID, upload source, tag, or compatibility contract", () => {
  const detail = exactVersion();
  assert.throws(
    () => validateExactStagingVersion(
      JSON.stringify(detail),
      "bitcoin-p2p-check",
      VERSION_ID,
      COMMIT_SHA,
    ),
    /Worker 이름/u,
  );
  assert.throws(
    () => validateExactStagingVersion(
      JSON.stringify(detail),
      STAGING_WORKER_NAME,
      OTHER_VERSION_ID,
      COMMIT_SHA,
    ),
    /증적/u,
  );

  for (const mutate of [
    (version) => { version.metadata.source = "dash"; },
    (version) => { version.annotations["workers/tag"] = OTHER_COMMIT_SHA; },
    (version) => { version.resources.script_runtime.compatibility_date = "2026-08-24"; },
    (version) => { version.resources.script_runtime.compatibility_flags = ["nodejs_compat"]; },
    (version) => {
      version.resources.script_runtime.compatibility_flags = [
        "nodejs_compat",
        "global_fetch_strictly_public",
        "unreviewed_flag",
      ];
    },
    (version) => {
      version.resources.script_runtime.compatibility_flags = [
        "nodejs_compat",
        "nodejs_compat",
      ];
    },
  ]) {
    const version = exactVersion();
    mutate(version);
    assert.throws(() => validate(version));
  }

  assert.throws(
    () => validateExactStagingVersion(
      JSON.stringify(detail),
      STAGING_WORKER_NAME,
      VERSION_ID,
      "not-a-commit",
    ),
    /commit SHA/u,
  );
});

test("requires the Durable Object export and does not require Preview URLs", () => {
  assert.doesNotThrow(() => validate());
  const version = exactVersion();
  delete version.resources.script_runtime.exports;
  assert.throws(() => validate(version), /Durable Object export/u);
});

test("rejects missing, extra, duplicated, or modified staging bindings", () => {
  const mutations = [
    (version) => { version.resources.bindings.pop(); },
    (version) => {
      version.resources.bindings.push({ name: "UNREVIEWED_SECRET", type: "secret_text" });
    },
    (version) => { version.resources.bindings.find((binding) => binding.name === "DEPLOYMENT_ENV").text = "production"; },
    (version) => { version.resources.bindings.find((binding) => binding.name === "LIGHTNING_REQUEST_RATE_LIMITER").namespace_id = "production-namespace"; },
    (version) => { version.resources.bindings.find((binding) => binding.name === "LIGHTNING_REQUEST_RATE_LIMITER").simple.limit = 13; },
    (version) => { version.resources.bindings.find((binding) => binding.name === "LIGHTNING_REQUEST_RATE_LIMITER").simple.mitigation_timeout = 60; },
    (version) => { version.resources.bindings.find((binding) => binding.name === "ASSETS").unexpected = true; },
  ];

  for (const mutate of mutations) {
    const version = exactVersion();
    mutate(version);
    assert.throws(() => validate(version), /binding|allowlist/u);
  }

  const duplicate = exactVersion();
  duplicate.resources.bindings[4] = { name: "WORKER_VERSION", type: "assets" };
  assert.throws(() => validate(duplicate), /중복/u);
});

test("rejects malformed and oversized Wrangler staging version output", () => {
  for (const raw of ["", "not-json", "[]", "{}", JSON.stringify({ id: VERSION_ID })]) {
    assert.throws(
      () => validateExactStagingVersion(raw, STAGING_WORKER_NAME, VERSION_ID, COMMIT_SHA),
      undefined,
      raw,
    );
  }
  assert.throws(
    () => validateExactStagingVersion(
      "{".padEnd(MAX_STAGING_VERSION_JSON_BYTES + 1, " "),
      STAGING_WORKER_NAME,
      VERSION_ID,
      COMMIT_SHA,
    ),
    /허용 크기/u,
  );
});

test("pins the staging-only Wrangler target and bounded subprocess", async () => {
  const checker = await readFile(
    new URL("../scripts/check-staging-version.mjs", import.meta.url),
    "utf8",
  );
  assert.match(checker, /WRANGLER_VERSION = "4\.125\.0"/u);
  assert.match(checker, /"versions", "view", versionId/u);
  assert.match(checker, /"--config", STAGING_CONFIG_PATH/u);
  assert.match(checker, /"--name", STAGING_WORKER_NAME/u);
  assert.match(checker, /maxBuffer: MAX_STAGING_VERSION_JSON_BYTES/u);
  assert.match(checker, /timeout: 30_000/u);
  assert.match(checker, /EXPECTED_STAGING_EXPORTS/u);
});
