import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_STAGING_DEPLOYMENT_JSON_BYTES = 1_048_576;

const WRANGLER_VERSION = "4.125.0";
const STAGING_WORKER_NAME = "bitcoin-p2p-check-staging";
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const STAGING_CONFIG_PATH = path.join(PROJECT_ROOT, "wrangler.staging.jsonc");
const WRANGLER_CLI_PATH = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const WRANGLER_PACKAGE_PATH = fileURLToPath(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
}

function hasExactKeys(value, expectedKeys) {
  return Object.keys(value).sort().join("\0") === [...expectedKeys].sort().join("\0");
}

export function parseStagingDeploymentState(raw) {
  if (typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > MAX_STAGING_DEPLOYMENT_JSON_BYTES) {
    throw new Error("Wrangler staging deployment 출력이 비어 있거나 허용 크기를 초과했습니다.");
  }

  let deployment;
  try {
    deployment = JSON.parse(raw);
  } catch {
    throw new Error("Wrangler staging deployment 출력이 유효한 JSON이 아닙니다.");
  }
  if (!deployment
    || typeof deployment !== "object"
    || Array.isArray(deployment)
    || typeof deployment.id !== "string"
    || !UUID_PATTERN.test(deployment.id)
    || deployment.strategy !== "percentage"
    || !Array.isArray(deployment.versions)
    || deployment.versions.length === 0) {
    throw new Error("Wrangler staging deployment 형식을 확인하지 못했습니다.");
  }

  const versionIds = new Set();
  const versions = deployment.versions.map((version, index) => {
    if (!version
      || typeof version !== "object"
      || Array.isArray(version)
      || !hasExactKeys(version, ["percentage", "version_id"])) {
      throw new Error(`Wrangler staging deployment의 ${index + 1}번째 version 형식이 올바르지 않습니다.`);
    }
    assertUuid(version.version_id, `Wrangler staging deployment의 ${index + 1}번째 version ID`);
    if (versionIds.has(version.version_id)) {
      throw new Error("Wrangler staging deployment에 중복된 version ID가 있습니다.");
    }
    if (typeof version.percentage !== "number"
      || !Number.isFinite(version.percentage)
      || version.percentage < 0
      || version.percentage > 100) {
      throw new Error(`Wrangler staging deployment의 ${index + 1}번째 traffic 비율이 올바르지 않습니다.`);
    }
    versionIds.add(version.version_id);
    return Object.freeze({
      versionId: version.version_id,
      percentage: version.percentage,
    });
  });
  const total = versions.reduce((sum, version) => sum + version.percentage, 0);
  if (Math.abs(total - 100) > Number.EPSILON) {
    throw new Error("Wrangler staging deployment의 traffic 비율 합계가 100이 아닙니다.");
  }
  return Object.freeze({
    deploymentId: deployment.id,
    versions: Object.freeze(versions),
  });
}

export function parseStagingDeployment(raw) {
  return parseStagingDeploymentState(raw).versions;
}

export function requireSingleStagingDeployment(
  raw,
  expectedVersionId,
  expectedDeploymentId,
) {
  const deployment = parseStagingDeploymentState(raw);
  const { versions } = deployment;
  if (versions.length !== 1 || versions[0].percentage !== 100) {
    throw new Error("staging deployment가 단일 version 100% 상태가 아닙니다.");
  }
  if (expectedVersionId !== undefined) {
    assertUuid(expectedVersionId, "예상 staging version ID");
    if (versions[0].versionId !== expectedVersionId) {
      throw new Error("staging deployment가 고정한 version과 다릅니다.");
    }
  }
  if (expectedDeploymentId !== undefined) {
    assertUuid(expectedDeploymentId, "예상 staging deployment ID");
    if (deployment.deploymentId !== expectedDeploymentId) {
      throw new Error("staging deployment ID가 고정한 deployment와 다릅니다.");
    }
  }
  return Object.freeze({
    deploymentId: deployment.deploymentId,
    versionId: versions[0].versionId,
  });
}

export function requireSingleStagingVersion(raw, expectedVersionId, expectedDeploymentId) {
  return requireSingleStagingDeployment(
    raw,
    expectedVersionId,
    expectedDeploymentId,
  ).versionId;
}

async function requirePinnedWrangler() {
  let packageManifest;
  try {
    packageManifest = JSON.parse(await readFile(WRANGLER_PACKAGE_PATH, "utf8"));
  } catch {
    throw new Error("설치된 Wrangler package 정보를 읽을 수 없습니다. 먼저 npm ci를 실행하십시오.");
  }
  if (packageManifest?.version !== WRANGLER_VERSION) {
    throw new Error(`Wrangler ${WRANGLER_VERSION}만 staging deployment 검사에 사용할 수 있습니다.`);
  }
}

function readStagingDeployment() {
  const result = spawnSync(
    process.execPath,
    [
      WRANGLER_CLI_PATH,
      "deployments", "status",
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
      maxBuffer: MAX_STAGING_DEPLOYMENT_JSON_BYTES,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("격리된 staging Worker deployment 조회에 실패했습니다. 인증, 권한, account와 대상을 확인하십시오.");
  }
  return result.stdout;
}

async function main() {
  const [mode, ...arguments_] = process.argv.slice(2);
  const capture = mode === "capture" && arguments_.length === 0;
  const captureExact = mode === "capture-exact" && arguments_.length === 1;
  const assertSingle = mode === "assert-single"
    && (arguments_.length === 1 || arguments_.length === 2);
  if (!capture && !captureExact && !assertSingle) {
    throw new Error(
      "사용법: check-staging-deployment.mjs capture | capture-exact <version-id> | assert-single <version-id> [deployment-id]",
    );
  }
  await requirePinnedWrangler();
  const raw = readStagingDeployment();

  if (capture || captureExact) {
    const deployment = requireSingleStagingDeployment(raw, captureExact ? arguments_[0] : undefined);
    const githubOutput = process.env.GITHUB_OUTPUT ?? "";
    if (!githubOutput) throw new Error("capture에는 GITHUB_OUTPUT이 필요합니다.");
    await appendFile(
      githubOutput,
      `version_id=${deployment.versionId}\ndeployment_id=${deployment.deploymentId}\n`,
      "utf8",
    );
    console.log(
      `현재 staging deployment ${deployment.deploymentId}와 version ${deployment.versionId} 단일 100% 상태를 고정했습니다.`,
    );
    return;
  }
  if (assertSingle) {
    requireSingleStagingDeployment(raw, arguments_[0], arguments_[1]);
    console.log(
      `staging version ${arguments_[0]} 단일 100%${arguments_[1] ? `, deployment ${arguments_[1]}` : ""} 상태를 확인했습니다.`,
    );
    return;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
