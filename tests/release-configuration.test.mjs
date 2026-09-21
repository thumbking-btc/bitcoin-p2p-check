import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateProductionConfig } from "../scripts/check-release-artifact.mjs";
import { validateStagingConfig } from "../scripts/check-staging-artifact.mjs";
import {
  parseStagingAtomicDeploy,
  parseStagingBootstrapDeploy,
} from "../scripts/record-staging-upload.mjs";

test("uploads the exact Worker bundle from Wrangler's hidden output directory", async () => {
  const workflow = await readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
  const step = workflow.match(
    / {6}- name: Preserve the exact verified Worker bundle[\s\S]*?(?=\r?\n\r?\n {6}- name: Preserve the exact verified staging Worker bundle)/u,
  )?.[0] ?? "";

  assert.ok(step, "verified Worker artifact upload step is missing");
  assert.match(step, /uses: actions\/upload-artifact@[0-9a-f]{40}\b/u);
  assert.match(step, /include-hidden-files:\s*true\b/u);
  assert.match(step, /if-no-files-found:\s*error\b/u);

  const pathBlock = step.match(/path:\s*\|\r?\n((?: {12}[^\r\n]+\r?\n?)+)/u)?.[1] ?? "";
  const artifactPaths = pathBlock
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(artifactPaths, [
    ".wrangler/dry-run/production/index.js",
    ".wrangler/dry-run/production/index.js.map",
  ]);
});

test("fails closed on account telemetry until a redacting export pipeline is verified", async () => {
  for (const path of ["../wrangler.jsonc", "../wrangler.staging.jsonc", "../wrangler.preview.jsonc"]) {
    const config = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
    assert.equal(config.observability?.enabled, false, `${path}: account observability must remain disabled`);
    assert.equal(config.observability?.head_sampling_rate, 0, `${path}: global sampling must remain zero`);
    assert.equal(config.observability?.logs?.enabled, false, `${path}: Workers Logs must remain disabled`);
    assert.equal(config.observability?.logs?.head_sampling_rate, 0, `${path}: log sampling must remain zero`);
    assert.equal(config.observability?.logs?.persist, false, `${path}: custom logs must not be persisted`);
    assert.equal(config.observability?.logs?.invocation_logs, false, `${path}: invocation URLs must not be persisted`);
    assert.deepEqual(config.observability?.logs?.destinations, [], `${path}: log export destinations must remain empty`);
    assert.equal(config.observability?.traces?.enabled, false, `${path}: automatic URL traces must be disabled`);
    assert.equal(config.observability?.traces?.head_sampling_rate, 0, `${path}: trace sampling must remain zero`);
    assert.equal(config.observability?.traces?.persist, false, `${path}: automatic URL traces must not be persisted`);
    assert.deepEqual(config.observability?.traces?.destinations, [], `${path}: trace export destinations must remain empty`);
  }
});

test("keeps the production Worker and every privileged binding on an exact allowlist", async () => {
  const [productionText, workflow] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8"),
  ]);
  const production = JSON.parse(productionText);
  assert.equal(validateProductionConfig(production), true);

  const mutations = [
    ["wrong worker", { ...production, name: "bitcoin-p2p-check-staging" }],
    ["route drift", { ...production, routes: ["example.com/*"] }],
    ["service drift", { ...production, services: [{ binding: "OTHER", service: "other" }] }],
    ["wrong KV", {
      ...production,
      kv_namespaces: [{ ...production.kv_namespaces[0], id: "00000000000000000000000000000000" }],
    }],
    ["unexpected Durable Object binding", {
      ...production,
      durable_objects: { bindings: [{ name: "TRADE_RECORD_STATE", class_name: "TradeRecordState" }] },
    }],
    ["wrong Durable Object export", {
      ...production,
      exports: { TradeRecordState: { type: "durable-object", storage: "kv" } },
    }],
    ["extra secret", {
      ...production,
      secrets: { required: [...production.secrets.required, "UNREVIEWED_SECRET"] },
    }],
    ["asset bypass", {
      ...production,
      assets: { ...production.assets, run_worker_first: false },
    }],
  ];
  for (const [label, mutation] of mutations) {
    assert.throws(() => validateProductionConfig(mutation), undefined, label);
  }

  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts["deploy:production"], /process\.exit\(1\)/u);
  assert.match(packageJson.scripts["upload:production:candidate"], /process\.exit\(1\)/u);
  const productionJobIndex = workflow.indexOf("  deploy-production:");
  assert.ok(productionJobIndex >= 0);
  const productionJob = workflow.slice(productionJobIndex);
  assert.match(productionJob, /environment:\s*production/u);
  assert.match(productionJob, /Refuse production deployment until the Durable Object export bootstrap is approved/u);
  assert.match(productionJob, /Production deployment blocked/u);
  assert.match(productionJob, /exit 1/u);
  assert.doesNotMatch(productionJob, /CLOUDFLARE_API_(?:TOKEN|KEY)/u);
  assert.doesNotMatch(productionJob, /wrangler (?:deploy|versions upload|versions deploy)/u);
  assert.doesNotMatch(workflow, /record-production-deploy\.mjs|production-upload|assert-zero-candidate/u);
});

test("keeps staging isolated and deploys only an exact smoke-tested artifact", async () => {
  const [workflow, packageText, stagingText, productionText, previewText, guard, statefulSmoke] = await Promise.all([
    readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.preview.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../scripts/check-staging-artifact.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/smoke-staging-trade-record.mjs", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);
  const staging = JSON.parse(stagingText);
  const production = JSON.parse(productionText);
  const preview = JSON.parse(previewText);

  assert.equal(staging.name, "bitcoin-p2p-check-staging");
  assert.notEqual(staging.name, production.name);
  assert.notEqual(staging.name, preview.name);
  assert.equal(staging.workers_dev, true);
  assert.equal(staging.preview_urls, false);
  assert.equal(staging.vars.DEPLOYMENT_ENV, "staging");
  assert.equal(staging.vars.TRADE_RECORDS_ENABLED, "true");
  assert.equal(Object.hasOwn(staging, "durable_objects"), false);
  assert.equal(Object.hasOwn(staging, "kv_namespaces"), false);
  assert.deepEqual(staging.secrets, { required: ["TRADE_RECORD_SIGNING_KEY"] });
  assert.deepEqual(staging.exports, { TradeRecordState: { type: "durable-object", storage: "sqlite" } });
  assert.equal(validateStagingConfig(staging), true);
  assert.throws(
    () => validateStagingConfig({ ...staging, routes: ["example.com/*"] }),
    /exact allowlist/u,
  );
  assert.throws(
    () => validateStagingConfig({ ...staging, assets: { ...staging.assets, directory: "./other" } }),
    /정적 자산 구성/u,
  );
  assert.throws(
    () => validateStagingConfig({ ...staging, services: [{ binding: "PRODUCTION", service: "bitcoin-p2p-check" }] }),
    /exact allowlist/u,
  );

  const rateLimitNamespaces = [production, staging, preview]
    .flatMap((config) => config.ratelimits ?? [])
    .map((binding) => binding.namespace_id);
  assert.equal(new Set(rateLimitNamespaces).size, rateLimitNamespaces.length);

  assert.match(packageJson.scripts["deploy:staging:verified"], /wrangler deploy[\s\S]*--no-bundle[\s\S]*--strict[\s\S]*wrangler\.staging\.jsonc/u);
  assert.doesNotMatch(packageJson.scripts["deploy:staging:verified"], /--name|preview-alias|versions upload/u);
  assert.match(packageJson.scripts["config:check"], /wrangler\.staging\.jsonc[\s\S]*dry-run\/staging/u);
  assert.match(packageJson.scripts["test:worker-runtime"], /vitest\.staging\.config\.ts/u);

  assert.match(workflow, /push:\s*\r?\n\s+branches:\s*\[main, staging\]/u);
  const verifyJobStart = workflow.indexOf("  verify:");
  const attestJobStart = workflow.indexOf("  attest-production:");
  const stagingJobStart = workflow.indexOf("  deploy-staging:");
  assert.ok(verifyJobStart >= 0 && verifyJobStart < attestJobStart && attestJobStart < stagingJobStart);
  const verifyJob = workflow.slice(verifyJobStart, attestJobStart);
  const attestJob = workflow.slice(attestJobStart, stagingJobStart);
  assert.doesNotMatch(verifyJob, /id-token:\s*write|attestations:\s*write|artifact-metadata:\s*write/u);
  assert.match(attestJob, /github\.ref == 'refs\/heads\/main'[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*inputs\.deploy_production/u);
  assert.match(attestJob, /id-token:\s*write[\s\S]*attestations:\s*write[\s\S]*artifact-metadata:\s*write/u);
  assert.match(attestJob, /name:\s*verified-dist-\$\{\{ github\.sha \}\}[\s\S]*name:\s*verified-worker-\$\{\{ github\.sha \}\}[\s\S]*name:\s*release-evidence-\$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(attestJob, /^\s+run:/mu, "privileged attestation job must not execute repository scripts");
  assert.match(workflow, /deploy-production:\s*\r?\n\s+needs:\s*\[verify, attest-production\]/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/staging'[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*inputs\.deploy_staging/u);
  assert.match(workflow, /environment:\s*staging/u);
  assert.match(workflow, /name:\s*verified-staging-worker-\$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(workflow, /--version-preview|--require-preview/u);
  assert.match(workflow, /WRANGLER_OUTPUT_FILE_PATH=\.wrangler\/staging-deploy\.jsonl/u);
  assert.match(workflow, /EXPECTED_WORKER_TAG="\$\{\{ github\.sha \}\}"/u);
  assert.match(workflow, /EXPECTED_WORKER_VERSION_ID="\$\{\{ steps\.staging-deployed\.outputs\.version_id \}\}"/u);
  const deployIndex = workflow.indexOf("Deploy the verified isolated staging artifact atomically");
  const configIndex = workflow.indexOf("Verify the exact staging deployment configuration");
  const canonicalSmokeIndex = workflow.indexOf("Verify canonical staging identity and static behavior");
  const statefulSmokeIndex = workflow.indexOf("Verify the full staging trade-record lifecycle with synthetic data");
  const finalBranchCheckIndex = workflow.indexOf("Detect a staging deployment or branch advance after smoke");
  assert.ok(deployIndex >= 0 && deployIndex < configIndex && configIndex < canonicalSmokeIndex);
  assert.ok(canonicalSmokeIndex < statefulSmokeIndex && statefulSmokeIndex < finalBranchCheckIndex);
  assert.match(workflow.slice(deployIndex, configIndex), /git fetch --no-tags origin staging[\s\S]*check-staging-deployment\.mjs assert-single[\s\S]*npm run deploy:staging:verified[\s\S]*record-staging-upload\.mjs --deploy[\s\S]*check-staging-deployment\.mjs capture-exact/u);
  assert.match(workflow.slice(canonicalSmokeIndex), /EXPECTED_WORKER_TAG="\$\{\{ github\.sha \}\}"/u);
  assert.match(workflow.slice(statefulSmokeIndex, finalBranchCheckIndex), /smoke-staging-trade-record\.mjs[\s\S]*STAGING_STATEFUL_TEST_APPROVED:\s*"true"/u);
  assert.match(workflow.slice(finalBranchCheckIndex), /git fetch --no-tags origin staging[\s\S]*git rev-parse origin\/staging[\s\S]*github\.sha[\s\S]*check-staging-deployment\.mjs assert-single[\s\S]*staging-deployment\.outputs\.deployment_id/u);

  assert.match(guard, /GITHUB_REF !== "refs\/heads\/staging"/u);
  assert.match(guard, /GITHUB_EVENT_NAME !== "workflow_dispatch"/u);
  assert.match(guard, /expectedTopLevelKeys/u);
  assert.match(guard, /Object\.keys\(config\)\.sort\(\)/u);
  assert.match(guard, /await verifyStagingAccountIdentity\(\)/u);
  assert.match(guard, /directory: "\.\/dist\/client"/u);
  assert.match(statefulSmoke, /redirect:\s*"error"/u);
  assert.match(statefulSmoke, /MAX_JSON_RESPONSE_BYTES/u);
  assert.match(statefulSmoke, /revokeTradeRecord/u);
  assert.match(statefulSmoke, /assertRecordAbsent/u);
  assert.match(statefulSmoke, /attempt <= 3/u);
  assert.doesNotMatch(statefulSmoke, /console\.(?:log|error)\([^\n]*capability/u);
});

test("pins the exact version returned by the atomic staging deploy", () => {
  const versionId = "87654321-4321-4abc-8def-abcdef123456";
  const expectedTag = "b".repeat(40);
  const expectedMessage = `GitHub Actions 12345 · staging v2.3.0 · ${expectedTag}`;
  const canonicalUrl = "https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev";
  const session = {
    type: "wrangler-session",
    version: 1,
    wrangler_version: "4.125.0",
    command_line_args: [
      "deploy",
      ".verified-staging-worker/index.js",
      "--no-bundle",
      "--upload-source-maps",
      "--strict",
      "--no-autoconfig",
      "--config",
      "wrangler.staging.jsonc",
      "--tag",
      expectedTag,
      "--message",
      expectedMessage,
    ],
    log_file_path: "/home/runner/.config/.wrangler/logs/wrangler-deploy.log",
    timestamp: "2026-08-26T00:00:00.000Z",
  };
  const deploy = {
    type: "deploy",
    version: 1,
    worker_name: "bitcoin-p2p-check-staging",
    worker_tag: null,
    version_id: versionId,
    targets: [canonicalUrl],
    worker_name_overridden: false,
    timestamp: "2026-08-26T00:00:01.000Z",
  };
  const output = (...events) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const parseDeploy = (raw) => parseStagingAtomicDeploy(
    raw,
    "bitcoin-p2p-check-staging",
    expectedTag,
    expectedMessage,
  );

  assert.deepEqual(parseDeploy(output(session, deploy)), { versionId, canonicalUrl });
  assert.throws(
    () => parseDeploy(output({ ...session, command_line_args: session.command_line_args.with(1, ".wrangler/dry-run/staging/index.js") }, deploy)),
    /atomic deploy 형식/u,
  );
  assert.throws(
    () => parseDeploy(output(session, { ...deploy, version_id: "not-a-version" })),
    /격리 Worker/u,
  );
  assert.throws(
    () => parseStagingAtomicDeploy(output(session, deploy), "bitcoin-p2p-check-staging", expectedTag, "bad\nmessage"),
    /deployment message/u,
  );
});

test("accepts only one exact Wrangler bootstrap deploy result for the isolated staging Worker", () => {
  const versionId = "87654321-4321-4abc-8def-abcdef123456";
  const canonicalUrl = "https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev";
  const expectedTag = "a".repeat(40);
  const bootstrapMessage = `Authorized local bootstrap · staging v2.3.0 · ${expectedTag}`;
  // Wrangler 4.125.0 writes this session envelope before its command result event.
  const sessionEvent = {
    type: "wrangler-session",
    version: 1,
    wrangler_version: "4.125.0",
    command_line_args: [
      "deploy",
      ".wrangler/dry-run/staging/index.js",
      "--no-bundle",
      "--upload-source-maps",
      "--strict",
      "--no-autoconfig",
      "--config",
      "wrangler.staging.jsonc",
      "--tag",
      expectedTag,
      "--message",
      bootstrapMessage,
    ],
    log_file_path: "/home/runner/.config/.wrangler/logs/wrangler-bootstrap.log",
    timestamp: "2026-08-26T00:00:00.000Z",
  };
  const deployEvent = {
    type: "deploy",
    version: 1,
    worker_name: "bitcoin-p2p-check-staging",
    worker_tag: null,
    version_id: versionId,
    targets: [canonicalUrl],
    worker_name_overridden: false,
    timestamp: "2026-08-26T00:00:01.000Z",
  };
  const output = (...events) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const valid = output(sessionEvent, deployEvent);
  const parseBootstrap = (raw, versionTag = expectedTag) => parseStagingBootstrapDeploy(
    raw,
    "bitcoin-p2p-check-staging",
    versionTag,
    "2.3.0",
  );

  assert.deepEqual(parseBootstrap(valid), {
    versionId,
    canonicalUrl,
  });

  const commandDriftCases = [
    ["wrong source", sessionEvent.command_line_args.with(1, ".verified-staging-worker/index.js")],
    ["missing flag", sessionEvent.command_line_args.filter((argument) => argument !== "--strict")],
    [
      "duplicate flag",
      [
        ...sessionEvent.command_line_args.slice(0, 5),
        "--no-bundle",
        ...sessionEvent.command_line_args.slice(5),
      ],
    ],
    [
      "flag order",
      [
        ...sessionEvent.command_line_args.slice(0, 2),
        "--strict",
        "--upload-source-maps",
        "--no-bundle",
        ...sessionEvent.command_line_args.slice(5),
      ],
    ],
    ["wrong config", sessionEvent.command_line_args.with(7, "wrangler.jsonc")],
    ["wrong tag", sessionEvent.command_line_args.with(9, "b".repeat(40))],
    [
      "wrong message",
      sessionEvent.command_line_args.with(
        11,
        `Authorized local bootstrap · staging bootstrap v2.3.0 · ${expectedTag}`,
      ),
    ],
    ["forbidden override", [...sessionEvent.command_line_args, "--name", "bitcoin-p2p-check"]],
  ];
  for (const [label, commandLineArgs] of commandDriftCases) {
    assert.throws(
      () => parseBootstrap(output({ ...sessionEvent, command_line_args: commandLineArgs }, deployEvent)),
      /고정된 Wrangler deploy 형식/u,
      label,
    );
  }
  assert.throws(
    () => parseBootstrap(valid, "not-a-sha"),
    /예상 스테이징 Worker tag/u,
  );
  assert.throws(
    () => parseStagingBootstrapDeploy(
      valid,
      "bitcoin-p2p-check-staging",
      expectedTag,
      "not-a-version",
    ),
    /staging 앱 버전/u,
  );
  assert.throws(
    () => parseBootstrap(output(sessionEvent, { ...deployEvent, worker_name_overridden: true })),
    /격리 Worker/u,
  );
  assert.throws(
    () => parseBootstrap(output(sessionEvent, {
      ...deployEvent,
      targets: ["https://bitcoin-p2p-check.thumbking-btc.workers.dev"],
    })),
    /격리 Worker/u,
  );
  assert.throws(
    () => parseBootstrap(output(sessionEvent, deployEvent, deployEvent)),
    /정확히 하나씩/u,
  );
  assert.throws(
    () => parseBootstrap(output(
      sessionEvent,
      { type: "command-failed", version: 1, message: "failed" },
    )),
    /정확히 하나씩/u,
  );
  assert.throws(
    () => parseBootstrap(output(
      sessionEvent,
      { type: "autoconfig", version: 1, command: "deploy", summary: {} },
      deployEvent,
    )),
    /정확히 하나씩/u,
  );
  assert.throws(
    () => parseBootstrap(output(
      sessionEvent,
      { type: "unknown-event", version: 1 },
      deployEvent,
    )),
    /정확히 하나씩/u,
  );
  assert.throws(
    () => parseBootstrap("{not-json}\n"),
    /JSONL event/u,
  );
  assert.throws(
    () => parseBootstrap("{".repeat(1_048_577)),
    /너무 큽니다/u,
  );
});

test("documents the isolated local bootstrap gate and requires its parser before smoke", async () => {
  const [runbook, recorder, checker] = await Promise.all([
    readFile(new URL("../docs/production-operations.md", import.meta.url), "utf8"),
    readFile(new URL("../scripts/record-staging-upload.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/check-staging-artifact.mjs", import.meta.url), "utf8"),
  ]);
  const bootstrapStart = runbook.indexOf("`wrangler versions upload`는 존재하지 않는 Worker를 최초 생성하지 못합니다.");
  const normalStagingStart = runbook.indexOf("bootstrap은 신규 격리 Worker 생성 예외", bootstrapStart);
  const bootstrapSection = runbook.slice(bootstrapStart, normalStagingStart);
  const normalStagingSection = runbook.slice(
    normalStagingStart,
    runbook.indexOf("### 정상 배포 — 현재 차단됨", normalStagingStart),
  );
  const versionsPreflightIndex = bootstrapSection.indexOf("npx wrangler versions list");
  const deploymentsPreflightIndex = bootstrapSection.indexOf("npx wrangler deployments list");
  const guardIndex = bootstrapSection.lastIndexOf("node scripts/check-staging-artifact.mjs --bootstrap");
  const deployIndex = bootstrapSection.indexOf("npx wrangler deploy .wrangler/dry-run/staging/index.js");
  const parserIndex = bootstrapSection.indexOf("node scripts/record-staging-upload.mjs --bootstrap");
  const secretListIndex = bootstrapSection.indexOf("npm run secrets:check:staging", parserIndex);
  const versionSecretIndex = bootstrapSection.indexOf(
    'node scripts/check-worker-version-secrets.mjs staging "$version_id"',
    parserIndex,
  );
  const versionConfigIndex = bootstrapSection.indexOf(
    'node scripts/check-staging-version.mjs "$version_id" "$BOOTSTRAP_COMMIT_SHA"',
    parserIndex,
  );
  const deploymentIndex = bootstrapSection.indexOf(
    'node scripts/check-staging-deployment.mjs assert-single "$version_id"',
    parserIndex,
  );
  const smokeIndex = bootstrapSection.indexOf("node scripts/smoke-deployment.mjs");

  assert.ok(bootstrapStart >= 0 && normalStagingStart > bootstrapStart);
  assert.ok(versionsPreflightIndex >= 0 && versionsPreflightIndex < guardIndex);
  assert.ok(deploymentsPreflightIndex >= 0 && deploymentsPreflightIndex < guardIndex);
  assert.ok(guardIndex >= 0 && guardIndex < deployIndex);
  assert.ok(deployIndex >= 0 && deployIndex < parserIndex);
  assert.ok(parserIndex < secretListIndex && secretListIndex < versionSecretIndex);
  assert.ok(versionSecretIndex < versionConfigIndex && versionConfigIndex < deploymentIndex);
  assert.ok(deploymentIndex < smokeIndex);
  assert.match(
    bootstrapSection,
    /git -C "\$SOURCE_REPO" worktree add --detach "\$BOOTSTRAP_WORKTREE" "\$BOOTSTRAP_COMMIT_SHA"/u,
  );
  assert.match(bootstrapSection, /test "\$\(node --version\)" = "v22\.19\.0"[\s\S]*npm ci[\s\S]*npm run verify:ci/u);
  assert.match(bootstrapSection, /git status --porcelain=v1 --untracked-files=all/u);
  assert.match(bootstrapSection, /test "\$codes" = "10007"/u);
  assert.match(
    bootstrapSection,
    /node scripts\/check-staging-artifact\.mjs --bootstrap\r?\n\s+WRANGLER_OUTPUT_FILE_PATH=/u,
  );
  assert.match(
    bootstrapSection,
    /--no-bundle --upload-source-maps --strict --no-autoconfig[\s\S]*--config wrangler\.staging\.jsonc[\s\S]*--tag "\$BOOTSTRAP_COMMIT_SHA"[\s\S]*--message "Authorized local bootstrap · staging v\$\{APP_VERSION\} · \$BOOTSTRAP_COMMIT_SHA"/u,
  );
  assert.doesNotMatch(bootstrapSection, /\bGITHUB_(?:SHA|RUN_ID|OUTPUT)\b/u);
  assert.doesNotMatch(bootstrapSection, /^\s*git push\b/mu);
  assert.match(
    bootstrapSection,
    /node scripts\/record-staging-upload\.mjs --bootstrap "\$BOOTSTRAP_OUTPUT" "\$BOOTSTRAP_RESULT"/u,
  );
  assert.doesNotMatch(bootstrapSection, /:\s*>\s*"\$BOOTSTRAP_RESULT"/u);
  assert.match(recorder, /modeOrOutputFile === "--bootstrap"/u);
  assert.match(recorder, /process\.env\.BOOTSTRAP_COMMIT_SHA/u);
  assert.match(recorder, /flag: "wx"/u);
  assert.match(checker, /BOOTSTRAP_DEPLOY_APPROVED/u);
  assert.match(checker, /symbolic-ref/u);
  assert.match(checker, /--git-common-dir/u);
  assert.match(
    normalStagingSection,
    /baseline capture부터 마지막 deployment·branch 재확인까지 단일 운영자 변경 창/u,
  );
  assert.match(normalStagingSection, /staging` branch push[\s\S]*Cloudflare Dashboard\/API[\s\S]*compare-and-swap/u);
});

test("local bootstrap guard rejects a GitHub-shaped execution context", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/check-staging-artifact.mjs", import.meta.url)),
      "--bootstrap",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BOOTSTRAP_DEPLOY_APPROVED: "true",
        BOOTSTRAP_COMMIT_SHA: "d".repeat(40),
        EXPECTED_APP_VERSION: "2.3.0",
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: "must-not-authorize-local-bootstrap",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /승인된 로컬 staging bootstrap 문맥/u);
});

test("bootstrap recorder exports only its validated version and canonical URL", async () => {
  const expectedTag = "c".repeat(40);
  const versionId = "abcdef12-3456-4abc-8def-abcdef123456";
  const canonicalUrl = "https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev";
  const events = [
    {
      type: "wrangler-session",
      version: 1,
      wrangler_version: "4.125.0",
      command_line_args: [
        "deploy",
        ".wrangler/dry-run/staging/index.js",
        "--no-bundle",
        "--upload-source-maps",
        "--strict",
        "--no-autoconfig",
        "--config",
        "wrangler.staging.jsonc",
        "--tag",
        expectedTag,
        "--message",
        `Authorized local bootstrap · staging v2.3.0 · ${expectedTag}`,
      ],
      log_file_path: "/home/runner/.config/.wrangler/logs/wrangler-bootstrap.log",
      timestamp: "2026-08-26T00:00:00.000Z",
    },
    {
      type: "deploy",
      version: 1,
      worker_name: "bitcoin-p2p-check-staging",
      worker_tag: null,
      version_id: versionId,
      targets: [canonicalUrl],
      worker_name_overridden: false,
      timestamp: "2026-08-26T00:00:01.000Z",
    },
  ];
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "p2p-staging-bootstrap-"));
  const wranglerOutput = path.join(temporaryDirectory, "wrangler.jsonl");
  const bootstrapResult = path.join(temporaryDirectory, "bootstrap-result.json");
  try {
    await writeFile(wranglerOutput, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/record-staging-upload.mjs", import.meta.url)),
        "--bootstrap",
        wranglerOutput,
        bootstrapResult,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BOOTSTRAP_COMMIT_SHA: expectedTag,
          EXPECTED_APP_VERSION: "2.3.0",
          GITHUB_SHA: "must-not-be-read",
          GITHUB_RUN_ID: "must-not-be-read",
          GITHUB_OUTPUT: path.join(temporaryDirectory, "must-not-be-created"),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(bootstrapResult, "utf8"),
      `${JSON.stringify({ version_id: versionId, canonical_url: canonicalUrl })}\n`,
    );

    const duplicateResult = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/record-staging-upload.mjs", import.meta.url)),
        "--bootstrap",
        wranglerOutput,
        bootstrapResult,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BOOTSTRAP_COMMIT_SHA: expectedTag,
          EXPECTED_APP_VERSION: "2.3.0",
        },
      },
    );
    assert.notEqual(duplicateResult.status, 0);
    assert.equal(
      await readFile(bootstrapResult, "utf8"),
      `${JSON.stringify({ version_id: versionId, canonical_url: canonicalUrl })}\n`,
    );
  } finally {
    await Promise.all([unlink(wranglerOutput), unlink(bootstrapResult)]);
    await rmdir(temporaryDirectory);
  }
});
