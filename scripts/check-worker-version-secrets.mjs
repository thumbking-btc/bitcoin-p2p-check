import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertExactSecretAllowlist,
  getWorkerSecretProfile,
} from "./check-worker-secrets.mjs";

export const MAX_WRANGLER_VERSION_JSON_BYTES = 4 * 1_024 * 1_024;

const WRANGLER_VERSION = "4.125.0";
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER_CLI_PATH = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const WRANGLER_PACKAGE_PATH = fileURLToPath(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
);
const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BINDING_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

function parseBoundedJson(raw, label) {
  if (typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > MAX_WRANGLER_VERSION_JSON_BYTES) {
    throw new Error(`${label}이 비어 있거나 허용 크기를 초과했습니다.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label}이 유효한 JSON이 아닙니다.`);
  }
}

export function parseLatestWorkerVersionId(raw) {
  const parsed = parseBoundedJson(raw, "Wrangler version 목록 출력");
  if (!Array.isArray(parsed)) {
    throw new Error("Wrangler version 목록 출력의 최상위 값은 배열이어야 합니다.");
  }
  let latest = null;
  const ids = new Set();
  const numbers = new Set();
  for (const [index, version] of parsed.entries()) {
    if (!version
      || typeof version !== "object"
      || Array.isArray(version)
      || typeof version.id !== "string"
      || !VERSION_ID_PATTERN.test(version.id)
      || !Number.isSafeInteger(version.number)
      || version.number < 1) {
      throw new Error(`Wrangler version 목록의 ${index + 1}번째 항목 형식이 올바르지 않습니다.`);
    }
    if (ids.has(version.id) || numbers.has(version.number)) {
      throw new Error("Wrangler version 목록에 중복된 ID 또는 번호가 있습니다.");
    }
    ids.add(version.id);
    numbers.add(version.number);
    if (!latest || version.number > latest.number) latest = { id: version.id, number: version.number };
  }
  return latest?.id ?? null;
}

export function parseWorkerVersionSecrets(raw, expectedVersionId) {
  if (typeof expectedVersionId !== "string" || !VERSION_ID_PATTERN.test(expectedVersionId)) {
    throw new Error("검사할 Worker version ID 형식이 올바르지 않습니다.");
  }
  const parsed = parseBoundedJson(raw, "Wrangler version 상세 출력");
  if (!parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || parsed.id !== expectedVersionId
    || !parsed.resources
    || typeof parsed.resources !== "object"
    || Array.isArray(parsed.resources)
    || !Array.isArray(parsed.resources.bindings)) {
    throw new Error("Wrangler version 상세 출력이 요청한 version의 bindings 형식과 일치하지 않습니다.");
  }

  const bindingNames = new Set();
  const secrets = [];
  for (const [index, binding] of parsed.resources.bindings.entries()) {
    if (!binding
      || typeof binding !== "object"
      || Array.isArray(binding)
      || typeof binding.name !== "string"
      || !BINDING_NAME_PATTERN.test(binding.name)
      || typeof binding.type !== "string"
      || binding.type.length === 0) {
      throw new Error(`Wrangler version bindings의 ${index + 1}번째 항목 형식이 올바르지 않습니다.`);
    }
    if (bindingNames.has(binding.name)) {
      throw new Error("Wrangler version bindings에 중복된 이름이 있습니다.");
    }
    bindingNames.add(binding.name);
    if (!binding.type.includes("secret")) continue;
    if (binding.type !== "secret_text") {
      throw new Error(`승인되지 않은 secret binding 유형 ${binding.type}이 있습니다.`);
    }
    secrets.push(Object.freeze({ name: binding.name, type: binding.type }));
  }
  return Object.freeze(secrets);
}

export function validateWorkerVersionSecrets(raw, expectedVersionId, expectedSecrets) {
  const actualSecrets = parseWorkerVersionSecrets(raw, expectedVersionId);
  assertExactSecretAllowlist(actualSecrets, expectedSecrets);
  return actualSecrets;
}

async function requirePinnedWrangler() {
  let packageManifest;
  try {
    packageManifest = JSON.parse(await readFile(WRANGLER_PACKAGE_PATH, "utf8"));
  } catch {
    throw new Error("설치된 Wrangler package 정보를 읽을 수 없습니다. 먼저 npm ci를 실행하십시오.");
  }
  if (packageManifest?.version !== WRANGLER_VERSION) {
    throw new Error(`Wrangler ${WRANGLER_VERSION}만 version secret 검사에 사용할 수 있습니다.`);
  }
}

function runWrangler(arguments_) {
  const result = spawnSync(process.execPath, [WRANGLER_CLI_PATH, ...arguments_], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_WRITE_LOGS: "0",
    },
    maxBuffer: MAX_WRANGLER_VERSION_JSON_BYTES,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("Wrangler version 조회에 실패했습니다. 인증, 권한, account와 Worker 대상을 확인하십시오.");
  }
  return result.stdout;
}

async function main() {
  const [profileName, selector, ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length !== 0 || typeof selector !== "string") {
    throw new Error("검사 대상을 profile과 latest 또는 정확한 version ID로 지정하십시오.");
  }
  const profile = getWorkerSecretProfile(profileName);
  await requirePinnedWrangler();

  let versionId = selector;
  if (selector === "latest") {
    const list = runWrangler([
      "versions", "list",
      "--config", profile.config,
      "--name", profile.workerName,
      "--json",
    ]);
    versionId = parseLatestWorkerVersionId(list);
    if (versionId === null) {
      console.log(`${profileName} Worker에는 상속할 이전 version이 없습니다.`);
      return;
    }
  }
  if (!VERSION_ID_PATTERN.test(versionId)) {
    throw new Error("검사할 Worker version ID 형식이 올바르지 않습니다.");
  }

  const detail = runWrangler([
    "versions", "view", versionId,
    "--config", profile.config,
    "--name", profile.workerName,
    "--json",
  ]);
  validateWorkerVersionSecrets(detail, versionId, profile.expectedSecrets);
  console.log(`${profileName} Worker version ${versionId}의 secret exact allowlist를 확인했습니다.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
