import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const MAX_STAGING_VERSION_JSON_BYTES = 4 * 1_024 * 1_024;
export const STAGING_WORKER_NAME = "bitcoin-p2p-check-staging";

const WRANGLER_VERSION = "4.125.0";
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER_CLI_PATH = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const WRANGLER_PACKAGE_PATH = fileURLToPath(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
);
const STAGING_CONFIG_PATH = path.join(PROJECT_ROOT, "wrangler.staging.jsonc");
const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const EXPECTED_COMPATIBILITY_DATE = "2026-08-25";
const EXPECTED_COMPATIBILITY_FLAGS = Object.freeze([
  "global_fetch_strictly_public",
  "nodejs_compat",
]);
const EXPECTED_STAGING_BINDINGS = Object.freeze([
  Object.freeze({ name: "ASSETS", type: "assets" }),
  Object.freeze({ name: "DEPLOYMENT_ENV", text: "staging", type: "plain_text" }),
  Object.freeze({
    name: "LIGHTNING_REQUEST_RATE_LIMITER",
    namespace_id: "2026082591",
    simple: Object.freeze({ limit: 12, period: 60 }),
    type: "ratelimit",
  }),
  Object.freeze({ name: "TRADE_RECORDS_ENABLED", text: "false", type: "plain_text" }),
  Object.freeze({ name: "WORKER_VERSION", type: "version_metadata" }),
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseBoundedJson(raw) {
  if (typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > MAX_STAGING_VERSION_JSON_BYTES) {
    throw new Error("Wrangler staging version 출력이 비어 있거나 허용 크기를 초과했습니다.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Wrangler staging version 출력이 유효한 JSON이 아닙니다.");
  }
}

function assertVersionId(value, label) {
  if (typeof value !== "string" || !VERSION_ID_PATTERN.test(value)) {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
}

function assertCommitSha(value) {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error("예상 staging commit SHA 형식이 올바르지 않습니다.");
  }
}

function assertExactCompatibilityFlags(value) {
  if (!Array.isArray(value)
    || value.some((flag) => typeof flag !== "string")
    || new Set(value).size !== value.length) {
    throw new Error("staging compatibility flags 형식이 올바르지 않습니다.");
  }
  const sortedFlags = [...value].sort();
  if (!isDeepStrictEqual(sortedFlags, EXPECTED_COMPATIBILITY_FLAGS)) {
    throw new Error("staging compatibility flags가 exact allowlist와 다릅니다.");
  }
}

function assertExactStagingBindings(value) {
  if (!Array.isArray(value) || value.length !== EXPECTED_STAGING_BINDINGS.length) {
    throw new Error("staging Worker bindings가 exact allowlist와 다릅니다.");
  }
  const bindingNames = new Set();
  for (const [index, binding] of value.entries()) {
    if (!isPlainObject(binding)
      || typeof binding.name !== "string"
      || binding.name.length === 0) {
      throw new Error(`staging Worker의 ${index + 1}번째 binding 형식이 올바르지 않습니다.`);
    }
    if (bindingNames.has(binding.name)) {
      throw new Error("staging Worker bindings에 중복된 이름이 있습니다.");
    }
    bindingNames.add(binding.name);
  }
  const sortedBindings = [...value].sort((left, right) => left.name.localeCompare(right.name));
  if (!isDeepStrictEqual(sortedBindings, EXPECTED_STAGING_BINDINGS)) {
    throw new Error("staging Worker bindings가 exact allowlist와 다릅니다.");
  }
}

export function validateExactStagingVersion(
  raw,
  queriedWorkerName,
  expectedVersionId,
  expectedCommitSha,
  { requirePreview = false } = {},
) {
  if (queriedWorkerName !== STAGING_WORKER_NAME) {
    throw new Error("조회한 Worker 이름이 격리된 staging Worker와 다릅니다.");
  }
  assertVersionId(expectedVersionId, "예상 staging version ID");
  assertCommitSha(expectedCommitSha);

  const version = parseBoundedJson(raw);
  if (!isPlainObject(version)
    || version.id !== expectedVersionId
    || !Number.isSafeInteger(version.number)
    || version.number < 1
    || !isPlainObject(version.metadata)
    || version.metadata.source !== "wrangler"
    || !isPlainObject(version.annotations)
    || version.annotations["workers/tag"] !== expectedCommitSha
    || !isPlainObject(version.resources)
    || !isPlainObject(version.resources.script_runtime)) {
    throw new Error("Wrangler staging version 증적이 예상한 ID, source, tag 또는 구조와 다릅니다.");
  }
  if (requirePreview && version.metadata.has_preview !== true) {
    throw new Error("staging candidate version의 Preview 활성화 증적을 확인하지 못했습니다.");
  }
  if (version.resources.script_runtime.compatibility_date !== EXPECTED_COMPATIBILITY_DATE) {
    throw new Error("staging compatibility date가 검증된 값과 다릅니다.");
  }
  assertExactCompatibilityFlags(version.resources.script_runtime.compatibility_flags);
  assertExactStagingBindings(version.resources.bindings);

  return Object.freeze({
    workerName: queriedWorkerName,
    versionId: version.id,
    source: version.metadata.source,
    tag: version.annotations["workers/tag"],
    compatibilityDate: version.resources.script_runtime.compatibility_date,
    compatibilityFlags: EXPECTED_COMPATIBILITY_FLAGS,
    bindings: EXPECTED_STAGING_BINDINGS,
  });
}

async function requirePinnedWrangler() {
  let packageManifest;
  try {
    packageManifest = JSON.parse(await readFile(WRANGLER_PACKAGE_PATH, "utf8"));
  } catch {
    throw new Error("설치된 Wrangler package 정보를 읽을 수 없습니다. 먼저 npm ci를 실행하십시오.");
  }
  if (packageManifest?.version !== WRANGLER_VERSION) {
    throw new Error(`Wrangler ${WRANGLER_VERSION}만 staging version 검사에 사용할 수 있습니다.`);
  }
}

function readStagingVersion(versionId) {
  const result = spawnSync(
    process.execPath,
    [
      WRANGLER_CLI_PATH,
      "versions", "view", versionId,
      "--config", STAGING_CONFIG_PATH,
      "--name", STAGING_WORKER_NAME,
      "--json",
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "0",
      },
      maxBuffer: MAX_STAGING_VERSION_JSON_BYTES,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("격리된 staging Worker version 조회에 실패했습니다. 인증, 권한, account와 대상을 확인하십시오.");
  }
  return result.stdout;
}

async function main() {
  const [versionId, expectedCommitSha, previewFlag, ...extraArguments] = process.argv.slice(2);
  const requirePreview = previewFlag === "--require-preview";
  if (extraArguments.length !== 0 || (previewFlag && !requirePreview)) {
    throw new Error("사용법: check-staging-version.mjs <exact-version-id> <expected-commit-sha> [--require-preview]");
  }
  assertVersionId(versionId, "staging version ID");
  assertCommitSha(expectedCommitSha);
  await requirePinnedWrangler();
  validateExactStagingVersion(
    readStagingVersion(versionId),
    STAGING_WORKER_NAME,
    versionId,
    expectedCommitSha,
    { requirePreview },
  );
  console.log(`staging Worker version ${versionId}의 exact 구성과 commit ${expectedCommitSha}를 확인했습니다.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
