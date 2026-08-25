import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
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

const [headers, policy, config] = await Promise.all([
  readFile(path.join(projectRoot, "dist/client/_headers"), "utf8"),
  readFile(path.join(projectRoot, "dist/client/csp-policy.txt"), "utf8"),
  readFile(path.join(projectRoot, "wrangler.jsonc"), "utf8"),
]);

const assertions = [
  [!headers.includes("Content-Security-Policy"), "Cloudflare _headers의 2,000자 제한을 넘길 수 있는 CSP가 남아 있습니다."],
  [!policy.includes("unsafe-inline"), "배포 CSP에 unsafe-inline이 남아 있습니다."],
  [/script-src[^\n]*sha256-/i.test(policy), "배포 CSP에 정적 HTML script hash가 없습니다."],
  [policy.trim().length <= 16_384 && !/[\r\n].+[\r\n]/u.test(policy), "배포 CSP 정책 파일의 형식 또는 크기가 올바르지 않습니다."],
  [/"main"\s*:\s*"\.\/worker\/index\.ts"/.test(config), "프로덕션 Worker 진입점이 worker/index.ts가 아닙니다."],
  [/"preview_urls"\s*:\s*false/.test(config), "프로덕션 preview URL이 비활성화되지 않았습니다."],
  [/"DEPLOYMENT_ENV"\s*:\s*"production"/.test(config), "프로덕션 환경 표지가 없습니다."],
  [/"TRADE_RECORDS_ENABLED"\s*:\s*"true"/.test(config), "프로덕션 거래 기록 기능이 명시적으로 활성화되지 않았습니다."],
  [/"TRADE_RECORD_SIGNING_KEY"/.test(config), "거래 기록 서명키가 필수 secret으로 선언되지 않았습니다."],
  [/"binding"\s*:\s*"ASSETS"/.test(config), "정적 자산 Worker binding이 없습니다."],
  [/"run_worker_first"\s*:\s*true/.test(config), "HTML CSP와 API를 적용할 Worker-first 라우팅이 없습니다."],
];

for (const [condition, message] of assertions) {
  if (!condition) throw new Error(message);
}

console.log("프로덕션 배포 산출물과 명시적 Worker 구성을 확인했습니다.");
