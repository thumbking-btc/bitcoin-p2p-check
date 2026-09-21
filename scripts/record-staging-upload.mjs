import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_WRANGLER_OUTPUT_BYTES = 1_048_576;
const STAGING_WORKER_NAME = "bitcoin-p2p-check-staging";
const STAGING_CANONICAL_URL = `https://${STAGING_WORKER_NAME}.thumbking-btc.workers.dev`;
const STAGING_BOOTSTRAP_SOURCE = ".wrangler/dry-run/staging/index.js";
const STAGING_DEPLOY_SOURCE = ".verified-staging-worker/index.js";
const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VERSION_TAG_PATTERN = /^[0-9a-f]{40}$/u;
const APP_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const WRANGLER_VERSION = "4.125.0";

function requireStagingWorkerName(expectedWorkerName) {
  if (expectedWorkerName !== STAGING_WORKER_NAME) {
    throw new Error("예상 스테이징 Worker 이름을 확인하지 못했습니다.");
  }
}

function requireVersionTag(expectedVersionTag) {
  if (typeof expectedVersionTag !== "string" || !VERSION_TAG_PATTERN.test(expectedVersionTag)) {
    throw new Error("예상 스테이징 Worker tag를 확인하지 못했습니다.");
  }
}

function requireBootstrapContext(expectedAppVersion) {
  if (typeof expectedAppVersion !== "string"
    || expectedAppVersion.length > 128
    || !APP_VERSION_PATTERN.test(expectedAppVersion)) {
    throw new Error("예상 staging 앱 버전을 확인하지 못했습니다.");
  }
}

function canonicalBootstrapArgs(expectedVersionTag, expectedAppVersion) {
  return [
    "deploy",
    STAGING_BOOTSTRAP_SOURCE,
    "--no-bundle",
    "--upload-source-maps",
    "--strict",
    "--no-autoconfig",
    "--config",
    "wrangler.staging.jsonc",
    "--tag",
    expectedVersionTag,
    "--message",
    `Authorized local bootstrap · staging v${expectedAppVersion} · ${expectedVersionTag}`,
  ];
}

function requireDeploymentMessage(expectedMessage) {
  const hasControlCharacter = typeof expectedMessage === "string"
    && [...expectedMessage].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
  if (typeof expectedMessage !== "string"
    || expectedMessage.length < 1
    || expectedMessage.length > 512
    || hasControlCharacter) {
    throw new Error("예상 staging deployment message를 확인하지 못했습니다.");
  }
}

function canonicalDeployArgs(expectedVersionTag, expectedMessage) {
  return [
    "deploy",
    STAGING_DEPLOY_SOURCE,
    "--no-bundle",
    "--upload-source-maps",
    "--strict",
    "--no-autoconfig",
    "--config",
    "wrangler.staging.jsonc",
    "--tag",
    expectedVersionTag,
    "--message",
    expectedMessage,
  ];
}

function parseWranglerOutputEvents(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_WRANGLER_OUTPUT_BYTES) {
    throw new Error("Wrangler output 파일이 너무 큽니다.");
  }

  const lines = raw.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error("Wrangler bootstrap output이 빈 줄 없는 JSONL 형식이 아닙니다.");
  }

  try {
    return lines.map((line) => {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new TypeError("Wrangler event가 객체가 아닙니다.");
      }
      return event;
    });
  } catch {
    throw new Error("Wrangler bootstrap output이 유효한 JSONL event 목록이 아닙니다.");
  }
}

function isWranglerTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseStagingBootstrapDeploy(
  raw,
  expectedWorkerName,
  expectedVersionTag,
  expectedAppVersion,
) {
  requireStagingWorkerName(expectedWorkerName);
  requireVersionTag(expectedVersionTag);
  requireBootstrapContext(expectedAppVersion);
  const events = parseWranglerOutputEvents(raw);
  if (events.length !== 2
    || events[0].type !== "wrangler-session"
    || events[1].type !== "deploy") {
    throw new Error("Wrangler bootstrap output에는 wrangler-session 다음 deploy event만 정확히 하나씩 있어야 합니다.");
  }

  const [session, deploy] = events;
  const commandLineArgs = session.command_line_args;
  const expectedArgs = canonicalBootstrapArgs(expectedVersionTag, expectedAppVersion);
  if (session.version !== 1
    || session.wrangler_version !== WRANGLER_VERSION
    || !Array.isArray(commandLineArgs)
    || commandLineArgs.length !== expectedArgs.length
    || !commandLineArgs.every((argument, index) => argument === expectedArgs[index])
    || typeof session.log_file_path !== "string"
    || session.log_file_path.length === 0
    || !isWranglerTimestamp(session.timestamp)) {
    throw new Error("Wrangler bootstrap session이 고정된 Wrangler deploy 형식과 일치하지 않습니다.");
  }
  if (deploy.type !== "deploy"
    || deploy.version !== 1
    || deploy.worker_name !== expectedWorkerName
    || deploy.worker_name_overridden !== false
    || typeof deploy.version_id !== "string"
    || !VERSION_ID_PATTERN.test(deploy.version_id)
    || !Array.isArray(deploy.targets)
    || deploy.targets.length !== 1
    || deploy.targets[0] !== STAGING_CANONICAL_URL
    || !isWranglerTimestamp(deploy.timestamp)) {
    throw new Error("Wrangler bootstrap deploy 결과가 예상한 격리 Worker와 일치하지 않습니다.");
  }
  return Object.freeze({
    versionId: deploy.version_id,
    canonicalUrl: STAGING_CANONICAL_URL,
  });
}

export function parseStagingAtomicDeploy(
  raw,
  expectedWorkerName,
  expectedVersionTag,
  expectedMessage,
) {
  requireStagingWorkerName(expectedWorkerName);
  requireVersionTag(expectedVersionTag);
  requireDeploymentMessage(expectedMessage);
  const events = parseWranglerOutputEvents(raw);
  if (events.length !== 2
    || events[0].type !== "wrangler-session"
    || events[1].type !== "deploy") {
    throw new Error("Wrangler staging deploy output에는 wrangler-session 다음 deploy event만 정확히 하나씩 있어야 합니다.");
  }

  const [session, deploy] = events;
  const expectedArgs = canonicalDeployArgs(expectedVersionTag, expectedMessage);
  if (session.version !== 1
    || session.wrangler_version !== WRANGLER_VERSION
    || !Array.isArray(session.command_line_args)
    || session.command_line_args.length !== expectedArgs.length
    || !session.command_line_args.every((argument, index) => argument === expectedArgs[index])
    || typeof session.log_file_path !== "string"
    || session.log_file_path.length === 0
    || !isWranglerTimestamp(session.timestamp)) {
    throw new Error("Wrangler staging deploy session이 고정된 atomic deploy 형식과 일치하지 않습니다.");
  }
  if (deploy.version !== 1
    || deploy.worker_name !== expectedWorkerName
    || deploy.worker_name_overridden !== false
    || typeof deploy.version_id !== "string"
    || !VERSION_ID_PATTERN.test(deploy.version_id)
    || !Array.isArray(deploy.targets)
    || deploy.targets.length !== 1
    || deploy.targets[0] !== STAGING_CANONICAL_URL
    || !isWranglerTimestamp(deploy.timestamp)) {
    throw new Error("Wrangler staging deploy 결과가 예상한 격리 Worker와 일치하지 않습니다.");
  }
  return Object.freeze({ versionId: deploy.version_id, canonicalUrl: STAGING_CANONICAL_URL });
}

async function main() {
  const cliArguments = process.argv.slice(2);
  const [modeOrOutputFile, bootstrapOutputFile, bootstrapResultFile] = cliArguments;
  const bootstrapMode = modeOrOutputFile === "--bootstrap";

  if (modeOrOutputFile === "--deploy") {
    const expectedCommitSha = process.env.STAGING_COMMIT_SHA ?? "";
    const expectedMessage = process.env.STAGING_DEPLOY_MESSAGE ?? "";
    const githubOutput = process.env.GITHUB_OUTPUT ?? "";
    if (cliArguments.length !== 2 || !bootstrapOutputFile || !githubOutput) {
      throw new Error("staging deploy 기록에는 Wrangler output 파일, commit, message와 GITHUB_OUTPUT이 필요합니다.");
    }
    if (path.resolve(bootstrapOutputFile) === path.resolve(githubOutput)) {
      throw new Error("Wrangler output 파일과 GitHub output 파일은 서로 달라야 합니다.");
    }
    const deploy = parseStagingAtomicDeploy(
      await readFile(bootstrapOutputFile, "utf8"),
      STAGING_WORKER_NAME,
      expectedCommitSha,
      expectedMessage,
    );
    await appendFile(githubOutput, `version_id=${deploy.versionId}\n`, "utf8");
    console.log(`스테이징 atomic deploy version ${deploy.versionId}를 고정했습니다.`);
    return;
  }

  const expectedCommitSha = process.env.BOOTSTRAP_COMMIT_SHA ?? "";
  const expectedAppVersion = process.env.EXPECTED_APP_VERSION ?? "";
  if (!bootstrapMode
    || cliArguments.length !== 3
    || !bootstrapOutputFile
    || !bootstrapResultFile
    || !expectedCommitSha
    || !expectedAppVersion) {
    throw new Error(
      "bootstrap 기록에는 Wrangler output 파일, 신규 result 파일, BOOTSTRAP_COMMIT_SHA와 EXPECTED_APP_VERSION이 필요합니다.",
    );
  }
  if (path.resolve(bootstrapOutputFile) === path.resolve(bootstrapResultFile)) {
    throw new Error("Wrangler output 파일과 bootstrap result 파일은 서로 달라야 합니다.");
  }
  const deploy = parseStagingBootstrapDeploy(
    await readFile(bootstrapOutputFile, "utf8"),
    STAGING_WORKER_NAME,
    expectedCommitSha,
    expectedAppVersion,
  );
  await writeFile(
    bootstrapResultFile,
    `${JSON.stringify({
      version_id: deploy.versionId,
      canonical_url: deploy.canonicalUrl,
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  console.log(`스테이징 bootstrap version ${deploy.versionId}를 고정했습니다.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
