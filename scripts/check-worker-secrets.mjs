import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_WRANGLER_SECRET_LIST_BYTES = 65_536;

const WRANGLER_VERSION = "4.125.0";
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER_CLI_PATH = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const WRANGLER_PACKAGE_PATH = fileURLToPath(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
);
const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

const WORKER_PROFILES = Object.freeze({
  production: Object.freeze({
    config: "wrangler.jsonc",
    workerName: "bitcoin-p2p-check",
    expectedSecrets: Object.freeze([
      Object.freeze({ name: "TRADE_RECORD_SIGNING_KEY", type: "secret_text" }),
    ]),
  }),
  staging: Object.freeze({
    config: "wrangler.staging.jsonc",
    workerName: "bitcoin-p2p-check-staging",
    expectedSecrets: Object.freeze([
      Object.freeze({ name: "TRADE_RECORD_SIGNING_KEY", type: "secret_text" }),
    ]),
  }),
  preview: Object.freeze({
    config: "wrangler.preview.jsonc",
    workerName: "bitcoin-p2p-check-preview",
    expectedSecrets: Object.freeze([]),
  }),
});

export function getWorkerSecretProfile(profileName) {
  if (typeof profileName !== "string" || !Object.hasOwn(WORKER_PROFILES, profileName)) {
    throw new Error("검사 대상은 production, staging 또는 preview 중 하나여야 합니다.");
  }
  return WORKER_PROFILES[profileName];
}

function hasExactKeys(value, expectedKeys) {
  return Object.keys(value).sort().join("\0") === [...expectedKeys].sort().join("\0");
}

function assertSecretDescriptor(value, label) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || !hasExactKeys(value, ["name", "type"])
    || typeof value.name !== "string"
    || !SECRET_NAME_PATTERN.test(value.name)
    || value.type !== "secret_text") {
    throw new Error(`${label}이 { name, type: "secret_text" } 형식과 일치하지 않습니다.`);
  }
}

export function parseWranglerSecretList(raw) {
  if (typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > MAX_WRANGLER_SECRET_LIST_BYTES) {
    throw new Error("Wrangler secret 목록 출력이 비어 있거나 허용 크기를 초과했습니다.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Wrangler secret 목록 출력이 유효한 JSON이 아닙니다.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Wrangler secret 목록 출력의 최상위 값은 배열이어야 합니다.");
  }

  const names = new Set();
  for (const [index, secret] of parsed.entries()) {
    assertSecretDescriptor(secret, `Wrangler secret 목록의 ${index + 1}번째 항목`);
    if (names.has(secret.name)) {
      throw new Error("Wrangler secret 목록에 중복된 이름이 있습니다.");
    }
    names.add(secret.name);
  }

  return Object.freeze(parsed.map((secret) => Object.freeze({ ...secret })));
}

export function assertExactSecretAllowlist(actualSecrets, expectedSecrets) {
  if (!Array.isArray(actualSecrets) || !Array.isArray(expectedSecrets)) {
    throw new TypeError("실제 secret 목록과 예상 allowlist는 배열이어야 합니다.");
  }

  const actualByName = new Map();
  for (const [index, secret] of actualSecrets.entries()) {
    assertSecretDescriptor(secret, `실제 secret 목록의 ${index + 1}번째 항목`);
    if (actualByName.has(secret.name)) {
      throw new Error("실제 secret 목록에 중복된 이름이 있습니다.");
    }
    actualByName.set(secret.name, secret.type);
  }

  const expectedByName = new Map();
  for (const [index, secret] of expectedSecrets.entries()) {
    assertSecretDescriptor(secret, `예상 secret allowlist의 ${index + 1}번째 항목`);
    if (expectedByName.has(secret.name)) {
      throw new Error("예상 secret allowlist에 중복된 이름이 있습니다.");
    }
    expectedByName.set(secret.name, secret.type);
  }

  if (actualByName.size !== expectedByName.size
    || [...actualByName].some(([name, type]) => expectedByName.get(name) !== type)) {
    throw new Error("원격 Worker secret 목록이 승인된 exact allowlist와 일치하지 않습니다.");
  }

  return true;
}

export function validateWranglerSecretList(raw, expectedSecrets) {
  const actualSecrets = parseWranglerSecretList(raw);
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
    throw new Error(`Wrangler ${WRANGLER_VERSION}만 원격 secret 검사에 사용할 수 있습니다.`);
  }
}

async function main() {
  const [profileName, ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length !== 0) {
    throw new Error("검사 대상은 production, staging 또는 preview 중 하나여야 합니다.");
  }
  const profile = getWorkerSecretProfile(profileName);

  await requirePinnedWrangler();
  const result = spawnSync(
    process.execPath,
    [
      WRANGLER_CLI_PATH,
      "secret",
      "list",
      "--config",
      profile.config,
      "--name",
      profile.workerName,
      "--format",
      "json",
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "0",
      },
      maxBuffer: MAX_WRANGLER_SECRET_LIST_BYTES,
      timeout: 30_000,
      windowsHide: true,
    },
  );

  if (result.error || result.signal || result.status !== 0) {
    throw new Error("Wrangler secret list 조회에 실패했습니다. 인증, 권한, account와 Worker 대상을 확인하십시오.");
  }

  validateWranglerSecretList(result.stdout, profile.expectedSecrets);
  console.log(`${profileName} Worker 원격 secret exact allowlist를 확인했습니다.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
