import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const expectedTopLevelKeys = Object.freeze([
  "$schema",
  "assets",
  "compatibility_date",
  "compatibility_flags",
  "exports",
  "kv_namespaces",
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

function requireExact(value, expected, message) {
  if (!isDeepStrictEqual(value, expected)) throw new Error(message);
}

export function validateProductionConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("프로덕션 Wrangler 구성이 객체가 아닙니다.");
  }

  requireExact(
    Object.keys(config).sort(),
    expectedTopLevelKeys,
    "프로덕션 Wrangler 최상위 구성이 승인된 exact allowlist와 다릅니다.",
  );
  requireExact(config.$schema, "./node_modules/wrangler/config-schema.json", "프로덕션 Wrangler schema가 다릅니다.");
  requireExact(config.name, "bitcoin-p2p-check", "프로덕션 Worker 이름이 다릅니다.");
  requireExact(config.main, "./worker/index.ts", "프로덕션 Worker 진입점이 worker/index.ts가 아닙니다.");
  requireExact(config.compatibility_date, "2026-08-25", "프로덕션 compatibility date가 검증값과 다릅니다.");
  requireExact(
    config.compatibility_flags,
    ["nodejs_compat", "global_fetch_strictly_public"],
    "프로덕션 compatibility flags가 검증값과 다릅니다.",
  );
  requireExact(config.workers_dev, true, "프로덕션 canonical workers.dev 주소가 비활성화되어 있습니다.");
  requireExact(config.preview_urls, false, "프로덕션 preview URL이 비활성화되지 않았습니다.");
  requireExact(
    config.vars,
    { DEPLOYMENT_ENV: "production", TRADE_RECORDS_ENABLED: "true" },
    "프로덕션 환경 변수 구성이 승인된 값과 다릅니다.",
  );
  requireExact(
    config.secrets,
    { required: ["TRADE_RECORD_SIGNING_KEY"] },
    "프로덕션 secret 선언이 승인된 exact allowlist와 다릅니다.",
  );
  requireExact(
    config.kv_namespaces,
    [{ binding: "TRADE_RECORDS", id: "3ff4212d619a4355a0bc3d3d1cdbebe2" }],
    "프로덕션 KV binding이 승인된 namespace와 다릅니다.",
  );
  requireExact(
    config.exports,
    { TradeRecordState: { type: "durable-object", storage: "sqlite" } },
    "프로덕션 Durable Object export가 승인된 구성과 다릅니다.",
  );
  requireExact(
    config.ratelimits,
    [
      {
        name: "TRADE_RECORD_CREATE_RATE_LIMITER",
        namespace_id: "2026082501",
        simple: { limit: 6, period: 60 },
      },
      {
        name: "TRADE_RECORD_READ_RATE_LIMITER",
        namespace_id: "2026082503",
        simple: { limit: 120, period: 60 },
      },
      {
        name: "LIGHTNING_REQUEST_RATE_LIMITER",
        namespace_id: "2026082502",
        simple: { limit: 12, period: 60 },
      },
    ],
    "프로덕션 rate-limit binding이 승인된 구성과 다릅니다.",
  );
  requireExact(
    config.version_metadata,
    { binding: "WORKER_VERSION" },
    "프로덕션 Worker version metadata binding이 다릅니다.",
  );
  requireExact(config.observability, expectedObservability, "프로덕션 observability가 fail-closed 구성이 아닙니다.");
  requireExact(
    config.assets,
    {
      directory: "./dist/client",
      binding: "ASSETS",
      html_handling: "auto-trailing-slash",
      not_found_handling: "404-page",
      run_worker_first: true,
    },
    "프로덕션 정적 자산 구성이 승인된 exact allowlist와 다릅니다.",
  );
  return true;
}

async function main() {
  const releaseSha = process.env.GITHUB_SHA ?? "";
  if (
    process.env.GITHUB_ACTIONS !== "true"
    || process.env.GITHUB_REF !== "refs/heads/main"
    || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || process.env.RELEASE_DEPLOY_APPROVED !== "true"
    || !/^[0-9a-f]{40}$/u.test(releaseSha)
  ) {
    throw new Error("프로덕션 배포는 main의 승인된 GitHub Actions workflow_dispatch에서만 허용합니다.");
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
    ".verified-worker/index.js",
    ".verified-worker/index.js.map",
  ];
  await Promise.all(requiredArtifacts.map((file) => access(path.join(projectRoot, file))));

  const [headers, policy, configText] = await Promise.all([
    readFile(path.join(projectRoot, "dist/client/_headers"), "utf8"),
    readFile(path.join(projectRoot, "dist/client/csp-policy.txt"), "utf8"),
    readFile(path.join(projectRoot, "wrangler.jsonc"), "utf8"),
  ]);
  validateProductionConfig(JSON.parse(configText));

  const assertions = [
    [!headers.includes("Content-Security-Policy"), "Cloudflare _headers의 2,000자 제한을 넘길 수 있는 CSP가 남아 있습니다."],
    [!policy.includes("unsafe-inline"), "배포 CSP에 unsafe-inline이 남아 있습니다."],
    [/script-src[^\n]*sha256-/iu.test(policy), "배포 CSP에 정적 HTML script hash가 없습니다."],
    [policy.trim().length <= 16_384 && !/[\r\n].+[\r\n]/u.test(policy), "배포 CSP 정책 파일의 형식 또는 크기가 올바르지 않습니다."],
  ];
  for (const [condition, message] of assertions) {
    if (!condition) throw new Error(message);
  }
  console.log("프로덕션 배포 산출물과 명시적 Worker 구성을 확인했습니다.");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
