import { spawnSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyStagingAccountIdentity } from "./check-staging-account.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const expectedTopLevelKeys = Object.freeze([
  "$schema",
  "assets",
  "compatibility_date",
  "compatibility_flags",
  "exports",
  "main",
  "name",
  "observability",
  "preview_urls",
  "ratelimits",
  "secrets",
  "vars",
  "version_metadata",
  "workers_dev",
].sort());
const expectedObservability = Object.freeze({
  enabled: false,
  head_sampling_rate: 0,
  logs: {
    enabled: false,
    head_sampling_rate: 0,
    invocation_logs: false,
    persist: false,
    destinations: [],
  },
  traces: {
    enabled: false,
    head_sampling_rate: 0,
    persist: false,
    destinations: [],
  },
});
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const APP_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const LOCAL_BOOTSTRAP_NODE_VERSION = "v22.19.0";
const LOCAL_ONLY_FILES = Object.freeze([
  "ADVERSARIAL_PRODUCT_AUDIT_2026-08-25.md",
  "AGENTS.md",
  "AUDIT_REPORT_2026-08-25.md",
]);

function requireExact(value, expected, message) {
  if (!isDeepStrictEqual(value, expected)) throw new Error(message);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function validateStagingConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("스테이징 Wrangler 구성이 객체가 아닙니다.");
  }

  requireExact(
    Object.keys(config).sort(),
    expectedTopLevelKeys,
    "스테이징 Wrangler 최상위 구성이 승인된 exact allowlist와 다릅니다.",
  );
  requireExact(config.$schema, "./node_modules/wrangler/config-schema.json", "스테이징 Wrangler schema가 다릅니다.");
  requireExact(config.name, "bitcoin-p2p-check-staging", "스테이징 Worker 이름이 격리된 이름이 아닙니다.");
  requireExact(config.main, "./worker/index.ts", "스테이징 Worker 진입점이 worker/index.ts가 아닙니다.");
  requireExact(config.compatibility_date, "2026-08-25", "스테이징 compatibility date가 검증값과 다릅니다.");
  requireExact(
    config.compatibility_flags,
    ["nodejs_compat", "global_fetch_strictly_public"],
    "스테이징 compatibility flags가 검증값과 다릅니다.",
  );
  requireExact(config.workers_dev, true, "스테이징 canonical workers.dev 주소가 비활성화되어 있습니다.");
  requireExact(config.preview_urls, false, "Durable Object staging Worker의 preview URL이 비활성화되지 않았습니다.");
  requireExact(
    config.vars,
    { DEPLOYMENT_ENV: "staging", TRADE_RECORDS_ENABLED: "true" },
    "스테이징 환경 변수 구성이 승인된 값과 다릅니다.",
  );
  requireExact(
    config.secrets,
    { required: ["TRADE_RECORD_SIGNING_KEY"] },
    "스테이징 signing secret 선언이 승인된 exact allowlist와 다릅니다.",
  );
  requireExact(
    config.exports,
    { TradeRecordState: { type: "durable-object", storage: "sqlite" } },
    "스테이징 Durable Object export가 승인된 구성과 다릅니다.",
  );
  requireExact(
    config.ratelimits,
    [
      {
        name: "TRADE_RECORD_CREATE_RATE_LIMITER",
        namespace_id: "2026082692",
        simple: { limit: 6, period: 60 },
      },
      {
        name: "TRADE_RECORD_READ_RATE_LIMITER",
        namespace_id: "2026082693",
        simple: { limit: 120, period: 60 },
      },
      {
        name: "LIGHTNING_REQUEST_RATE_LIMITER",
        namespace_id: "2026082591",
        simple: { limit: 12, period: 60 },
      },
    ],
    "스테이징 rate-limit bindings가 격리된 exact allowlist와 다릅니다.",
  );
  requireExact(
    config.version_metadata,
    { binding: "WORKER_VERSION" },
    "스테이징 Worker version metadata binding이 다릅니다.",
  );
  requireExact(config.observability, expectedObservability, "스테이징 observability가 fail-closed 구성이 아닙니다.");
  requireExact(
    config.assets,
    {
      directory: "./dist/client",
      binding: "ASSETS",
      html_handling: "auto-trailing-slash",
      not_found_handling: "404-page",
      run_worker_first: true,
    },
    "스테이징 정적 자산 구성이 승인된 exact allowlist와 다릅니다.",
  );
  return true;
}

function runGit(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("로컬 bootstrap Git 상태를 확인하지 못했습니다.");
  }
  return result.stdout.trim();
}

async function requireAuthorizedLocalBootstrap(expectedCommitSha, expectedAppVersion) {
  if (process.env.BOOTSTRAP_DEPLOY_APPROVED !== "true"
    || process.env.GITHUB_ACTIONS === "true"
    || process.version !== LOCAL_BOOTSTRAP_NODE_VERSION
    || !COMMIT_SHA_PATTERN.test(expectedCommitSha)
    || typeof expectedAppVersion !== "string"
    || expectedAppVersion.length > 128
    || !APP_VERSION_PATTERN.test(expectedAppVersion)) {
    throw new Error("승인된 로컬 staging bootstrap 문맥을 확인하지 못했습니다.");
  }

  const topLevel = runGit(["rev-parse", "--show-toplevel"]);
  if (comparablePath(topLevel) !== comparablePath(projectRoot)) {
    throw new Error("bootstrap 검증 대상이 현재 저장소 루트와 다릅니다.");
  }
  if (runGit(["rev-parse", "HEAD"]) !== expectedCommitSha
    || runGit(["cat-file", "-t", "HEAD"]) !== "commit") {
    throw new Error("bootstrap worktree가 고정한 commit SHA와 다릅니다.");
  }

  const symbolicRef = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (symbolicRef.error || symbolicRef.signal || symbolicRef.status !== 1 || symbolicRef.stdout.trim()) {
    throw new Error("bootstrap은 detached HEAD worktree에서만 실행할 수 있습니다.");
  }

  const gitDirectory = comparablePath(path.resolve(projectRoot, runGit(["rev-parse", "--git-dir"])));
  const commonGitDirectory = comparablePath(path.resolve(projectRoot, runGit(["rev-parse", "--git-common-dir"])));
  if (gitDirectory === commonGitDirectory) {
    throw new Error("bootstrap은 별도로 만든 linked temporary worktree에서만 실행할 수 있습니다.");
  }
  if (runGit(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("bootstrap worktree에 commit되지 않은 변경이 있습니다.");
  }

  const rootEntries = await readdir(projectRoot);
  const isolatedFiles = rootEntries.filter((name) => (
    /^\.env(?:\.|$)/iu.test(name)
    || /^\.dev\.vars(?:\.|$)/iu.test(name)
    || LOCAL_ONLY_FILES.includes(name)
  ));
  if (isolatedFiles.length !== 0) {
    throw new Error("bootstrap worktree에 격리해야 하는 사용자 보고서 또는 환경 파일이 있습니다.");
  }
  await verifyStagingAccountIdentity();
}

async function main() {
  const bootstrapMode = process.argv[2] === "--bootstrap";
  if (process.argv.length !== (bootstrapMode ? 3 : 2)) {
    throw new Error("알 수 없는 staging artifact 검사 인자입니다.");
  }

  let expectedAppVersion = "";
  if (bootstrapMode) {
    expectedAppVersion = process.env.EXPECTED_APP_VERSION ?? "";
    await requireAuthorizedLocalBootstrap(
      process.env.BOOTSTRAP_COMMIT_SHA ?? "",
      expectedAppVersion,
    );
  } else {
    const stagingSha = process.env.GITHUB_SHA ?? "";
    if (
      process.env.GITHUB_ACTIONS !== "true"
      || process.env.GITHUB_REF !== "refs/heads/staging"
      || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
      || process.env.STAGING_DEPLOY_APPROVED !== "true"
      || !COMMIT_SHA_PATTERN.test(stagingSha)
    ) {
      throw new Error("스테이징 업로드는 staging 브랜치의 명시적으로 승인된 GitHub Actions workflow_dispatch에서만 허용합니다.");
    }
    await verifyStagingAccountIdentity();
  }

  const requiredArtifacts = [
    "dist/client/index.html",
    "dist/client/404.html",
    "dist/client/install/index.html",
    "dist/client/privacy/index.html",
    "dist/client/verify/index.html",
    "dist/client/_headers",
    "dist/client/csp-policy.txt",
    "dist/client/sw.js",
    bootstrapMode ? ".wrangler/dry-run/staging/index.js" : ".verified-staging-worker/index.js",
    bootstrapMode ? ".wrangler/dry-run/staging/index.js.map" : ".verified-staging-worker/index.js.map",
  ];
  await Promise.all(requiredArtifacts.map((file) => access(path.join(projectRoot, file))));

  const [headers, policy, configText, packageText] = await Promise.all([
    readFile(path.join(projectRoot, "dist/client/_headers"), "utf8"),
    readFile(path.join(projectRoot, "dist/client/csp-policy.txt"), "utf8"),
    readFile(path.join(projectRoot, "wrangler.staging.jsonc"), "utf8"),
    readFile(path.join(projectRoot, "package.json"), "utf8"),
  ]);
  validateStagingConfig(JSON.parse(configText));
  if (bootstrapMode && JSON.parse(packageText).version !== expectedAppVersion) {
    throw new Error("bootstrap 앱 버전이 exact commit의 package.json과 다릅니다.");
  }

  if (headers.includes("Content-Security-Policy")) {
    throw new Error("Cloudflare _headers에 중복 CSP가 남아 있습니다.");
  }
  if (policy.includes("unsafe-inline")) {
    throw new Error("스테이징 CSP에 unsafe-inline이 남아 있습니다.");
  }
  if (!/script-src[^\n]*sha256-/iu.test(policy)) {
    throw new Error("스테이징 CSP에 정적 HTML script hash가 없습니다.");
  }
  console.log("격리된 스테이징 배포 산출물과 구성을 확인했습니다.");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
