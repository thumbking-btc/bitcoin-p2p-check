# 프로덕션 운영 런북

이 문서는 저장소에 선언된 배포·보안 불변조건과 운영자가 Cloudflare 및 GitHub에서 직접 확인해야 하는 절차를 정의합니다.

> 상태 고지: 2026-08-26 읽기 전용 실측에서 Cloudflare Git 연결과 production alias, GitHub 보호 부재 등 [감사 대장](./audit-remediation-2026-08-26.md)에 기록한 blocker를 확인했습니다. 그 뒤의 계정 상태, 경보 채널, 백업 작업 또는 배포 준비는 이 문서만으로 증명되지 않습니다. 아래 대시보드 항목은 담당자가 최신 증적을 남기며 수동으로 완료해야 하며, 체크하지 않은 항목을 완료된 것으로 간주하지 마십시오.

## 1. 배포 신뢰 경계

프로덕션 차단이 해제된 뒤의 목표 신뢰 경계는 다음과 같아야 합니다. 현재 저장소에는 마지막 배포 단계가 구현되어 있지 않습니다.

```text
main 최신 SHA → GitHub Actions verify 성공 → production environment 승인 → 동일 SHA·동일 dist 배포
```

Cloudflare의 Git 연동 빌드, 대시보드 편집기, 개발자 PC의 `wrangler deploy`, 기능 브랜치 프리뷰는 프로덕션 배포 경로가 아닙니다. Cloudflare의 Git 연동은 production 브랜치 push와 비-production 브랜치 build를 각각 실행할 수 있으므로, 이 저장소에서는 연동 자체를 끊는 것을 기준으로 삼습니다. Cloudflare는 Git 연동 해제 절차와 비-production 브랜치 build 토글을 별도로 설명합니다([Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), [Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)).

### Cloudflare 대시보드 수동 체크리스트

- [ ] **Workers & Pages → `bitcoin-p2p-check` → Settings → Builds → Disconnect**를 실행하여 GitHub/GitLab 저장소 연결을 해제했습니다.
- [ ] Settings → Builds에 production trigger와 preview trigger가 남아 있지 않음을 확인했습니다.
- [ ] 대시보드 편집 권한을 최소 운영자에게만 부여하고, Quick Edit로 프로덕션 코드를 변경하지 않는 정책을 기록했습니다.
- [ ] 활성 production version의 설정에서 `preview_urls: false`가 적용되었음을 배포 후 확인했습니다.
- [ ] 별도 Worker `bitcoin-p2p-check-staging`은 아래의 일회성 authorized local bootstrap 또는 `wrangler.staging.jsonc`를 사용하는 승인된 GitHub Actions 수동 실행으로만 배포하며, production Worker의 version alias나 저장소 branch build를 사용하지 않습니다.
- [ ] 별도 Worker `bitcoin-p2p-check-preview`는 명시적 수동 검증에서만 `wrangler.preview.jsonc`로 배포하며, 저장소 branch push와 연결하지 않았습니다.
- [ ] 위 항목의 화면 캡처, 확인자, 확인 시각(UTC)을 릴리스 증적에 첨부했습니다.

Git 연동이 남아 있거나 branch preview가 켜져 있으면 release gate가 완성되지 않은 상태입니다. Cloudflare build 명령을 `wrangler versions upload`로 바꾸는 방식은 자동 production 승격만 막을 뿐 Git trigger 자체를 없애지 않으므로 이 저장소의 기준을 충족하지 않습니다.

### GitHub 저장소 수동 체크리스트

`main` ruleset 또는 branch protection에는 다음 조건을 설정하십시오.

- [ ] Pull Request 없이 `main`을 갱신할 수 없습니다.
- [ ] 필수 status check는 GitHub Actions의 `verify` job이며 예상 source를 GitHub Actions로 고정했습니다.
- [ ] branch를 최신 상태로 갱신한 뒤 검사하도록 strict/up-to-date 조건을 켰습니다. GitHub의 required check는 최신 commit SHA에서 성공해야 합니다([Required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)).
- [ ] force push와 branch 삭제를 금지했습니다.
- [ ] 관리자 및 ruleset bypass 권한의 예외를 최소화하고 예외 사용 시 incident 기록을 요구합니다.
- [ ] workflow 파일 변경에는 별도 reviewer 또는 CODEOWNERS 승인을 요구합니다.

GitHub **Settings → Environments → production**에는 다음 조건을 설정하십시오.

- [ ] required reviewer를 지정했습니다.
- [ ] 배포 요청자가 자기 배포를 승인하지 못하도록 self-review 방지를 켰습니다.
- [ ] protection rule bypass를 허용하지 않습니다.
- [ ] 허용 deployment branch/tag를 `main`으로 제한했습니다.
- [ ] `CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID`는 repository secret이 아니라 `production` environment secret으로 저장했습니다.
- [ ] Cloudflare API token을 대상 account와 Worker 배포에 필요한 최소 권한으로 제한하고 만료일·교체 담당자를 기록했습니다. Cloudflare도 CI token을 저장소에 넣지 말고 account 범위를 제한하도록 안내합니다([GitHub Actions 배포](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)).

GitHub 요금제와 저장소 공개 범위에 따라 required reviewer 기능을 사용할 수 없는 경우가 있습니다. 그런 상태에서는 사람 승인이 강제된다고 표시하지 말고, 지원되는 요금제 또는 동등한 강제형 deployment protection을 먼저 마련하십시오([GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).

GitHub **Settings → Environments → staging**에는 최소권한 쓰기용 `CLOUDFLARE_API_TOKEN`, exact `CLOUDFLARE_ACCOUNT_ID`, 별도 읽기 전용 `CLOUDFLARE_STAGING_IDENTITY_TOKEN`을 environment secret으로 두고, 허용 branch를 `staging`으로 제한하십시오. 배포 직전 읽기 전용 token으로 exact account와 workers.dev subdomain을 확인한 뒤에만 쓰기 token을 사용합니다. `staging` push는 검증만 수행하며, `workflow_dispatch`에서 `deploy_staging=true`를 명시한 run만 검증된 산출물의 원자 배포와 synthetic lifecycle smoke를 수행합니다.

## 2. latest-main SHA 승인 체크리스트

현재 `deploy-production` job은 의도적으로 실패하므로 실행하거나 승인하지 마십시오. 아래 체크리스트는 compatibility export bootstrap과 후속 atomic production workflow가 별도로 검토·구현된 뒤 승인자가 변경 직전에 적용할 기준입니다. 과거에 성공한 run을 현재 `main` 배포 근거로 재사용하지 마십시오.

```bash
git fetch --prune origin main
git rev-parse origin/main
gh run view <RUN_ID> --json headSha,headBranch,event,status,conclusion,url
```

- [ ] `headBranch`가 `main`입니다.
- [ ] run의 `headSha`와 현재 원격 `origin/main` SHA가 완전히 같습니다.
- [ ] 같은 SHA의 `verify` job이 성공했습니다.
- [ ] `verified-dist-<SHA>`와 `verified-worker-<SHA>` artifact를 생성한 run과 배포 대기 중인 run이 같습니다.
- [ ] 승인 대기 중 `main`이 이동하지 않았습니다. 이동했다면 기존 run을 승인하지 않고 최신 SHA run을 사용합니다.
- [ ] 배포 대상이 `wrangler.jsonc`, Worker 이름 `bitcoin-p2p-check`임을 확인했습니다.
- [ ] 변경 내용, 위험, rollback 대상 Worker version ID, 담당자를 확인했습니다.

## 3. production, staging과 preview 격리

| 항목 | production | staging | preview |
| --- | --- | --- | --- |
| 설정 파일 | `wrangler.jsonc` | `wrangler.staging.jsonc` | `wrangler.preview.jsonc` |
| Worker 이름 | `bitcoin-p2p-check` | `bitcoin-p2p-check-staging` | `bitcoin-p2p-check-preview` |
| `DEPLOYMENT_ENV` | `production` | `staging` | `preview` |
| `TRADE_RECORDS_ENABLED` | `true` | `true` | `false` |
| 거래 기록 상태 | declarative `TradeRecordState` export와 `context.exports` loopback의 record별 SQLite DO; 명시적 `env` binding 없음 | 별도 `TradeRecordState` SQLite DO; production namespace와 공유하지 않음 | DO namespace 선언·binding 없음 |
| `TRADE_RECORDS` KV | legacy migration/mirror namespace | binding 없음 | binding 없음 |
| `TRADE_RECORD_SIGNING_KEY` | production 전용 required secret | staging 전용 required secret | 선언·주입하지 않음 |
| 거래 기록 limiter | create 6/min, item 120/min | 별도 namespace의 create 6/min, item 120/min | 없음 |
| version preview URL | `false` | Durable Object 제한으로 `false` | 명시적 preview Worker 검증용 `true` |

production Durable Object, KV namespace ID, 서명 secret, 공개키 신뢰 범위와 rate-limit namespace를 staging이나 preview에 복사하지 마십시오. staging은 같은 기능 계약을 별도 저장소·별도 signer로 시험하며, preview는 거래 기록 기능을 계속 fail closed로 유지합니다. production Worker의 `<version>-bitcoin-p2p-check...workers.dev` alias도 같은 Worker binding을 사용하므로 staging으로 취급하지 마십시오.

production의 `TradeRecordState`는 top-level Durable Object export와 [`context.exports` loopback binding](https://developers.cloudflare.com/workers/runtime-apis/context/#exports)으로만 접근합니다. 같은 Worker 안의 객체를 위한 `TRADE_RECORD_STATE` 환경 binding을 다시 추가하지 마십시오. 설정을 바꾼 뒤에는 `npm run types:worker`로 생성 타입을 갱신하고 `npm run types:check`로 drift를 검사하십시오.

배포 전 정적·로컬 검증은 다음과 같습니다.

```bash
npm run config:check
node --test tests/worker-security-lifecycle.test.mjs
```

`worker-security-lifecycle` 검사는 preview/누락 환경에서 거래 기록 API가 binding에 접근하기 전에 fail closed 되는지 확인합니다. production과 staging에서는 create와 item limiter가 Durable Object를 선택하기 전에 실행되는지 검사합니다. 테스트 파일이 없거나 이 검사가 제외된 release는 승인하지 마십시오.

명시적으로 배포한 staging 또는 preview에서 다음 **읽기 전용** 확인만 추가할 수 있습니다.

```bash
curl -sS -I "$PREVIEW_BASE_URL/api/trade-record"
curl -sS -D - -o /dev/null "$PREVIEW_BASE_URL/api/trade-record/AAAAAAAAAAAAAAAA"
```

첫 번째 `HEAD`는 503, 두 번째 `GET`은 404이며 두 응답 모두 JSON media type과 `Cache-Control: no-store`여야 합니다. 일상 smoke에서 `POST`, `PUT`, `PATCH`, `DELETE`를 호출하지 마십시오. production에서는 유효 형식이지만 존재하지 않는 ID에 대한 읽기 전용 `GET` negative test만 허용하며, 기록 생성·변경·철회 시험은 별도 승인된 synthetic 검증 창에서만 수행하십시오.

## 4. Secret 관리

### Secret 목록과 보관 위치

| 이름 | 보관 위치 | 용도 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | GitHub `production` environment secret | CI의 Worker 배포 인증 |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub `production` environment secret | 대상 account 고정 |
| `TRADE_RECORD_SIGNING_KEY` | Cloudflare production Worker secret | JSON 인코딩 P-256 private JWK |

`TRADE_RECORD_SIGNING_KEY`에는 고유한 `kid`, `kty: EC`, `crv: P-256`, `x`, `y`, `d`가 있어야 합니다. private `d`가 들어간 JWK 전체를 저장소, artifact, 로그, issue, GitHub Release, KV backup 또는 운영자 채팅에 넣지 마십시오. `.dev.vars*`와 `.env*`도 commit하지 마십시오.

Wrangler 설정의 `secrets.required`는 배포에 필요한 secret 이름을 검증하지만 원격 secret을 선언적으로 삭제하지 않습니다. 설정에서 이름을 제거하거나 secret 없는 bundle을 배포해도 기존 원격 secret은 명시적으로 삭제하기 전까지 남을 수 있으므로, 설정 파일 allowlist만으로 격리를 판단하지 마십시오([Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)). 다음 검사는 Wrangler 4.125.0의 `secret list --format json` 출력을 크기 제한과 exact schema로 파싱하며 secret 값은 조회하지 않습니다.

```bash
npm run secrets:check:production # TRADE_RECORD_SIGNING_KEY 하나만 허용
npm run secrets:check:staging    # staging 전용 TRADE_RECORD_SIGNING_KEY 하나만 허용
npm run secrets:check:preview    # 빈 목록만 허용
```

staging GitHub 배포 job은 원격 변경 직전과 직후에 각각 이 검사를 통과합니다. upload 전에 활성 deployment ID와 기존 version 단일 100% 상태를 함께 고정하고, 후보 upload 뒤와 승격 직후에는 정확한 후보 version의 전체 구성까지 검사합니다. production job은 현재 차단되어 있습니다. 향후 승인형 atomic production workflow는 현재 원격 목록·활성 version·새로 배포된 정확한 version을 각각 검사하되, 단순 이름·type 검사를 secret 값 자체의 attestation으로 표현하면 안 됩니다.

```bash
node scripts/check-worker-version-secrets.mjs production "$DEPLOYED_VERSION_ID" # TRADE_RECORD_SIGNING_KEY만 허용
node scripts/check-worker-version-secrets.mjs staging "$DEPLOYED_VERSION_ID"   # staging signer 하나만 허용
node scripts/check-staging-version.mjs "$CANDIDATE_VERSION_ID" "$EXPECTED_COMMIT_SHA"
node scripts/check-staging-deployment.mjs assert-single "$CANDIDATE_VERSION_ID"
```

secret version 검사는 `secret_text`만 secret 유형으로 인정하고, 다른 secret 계열 type·extra secret·중복 binding 이름·요청한 ID와 다른 응답·malformed/oversized JSON·조회 실패를 모두 fail closed로 처리합니다. staging exact version 검사는 Wrangler 4.125.0으로 Worker 이름을 `bitcoin-p2p-check-staging`에 고정하여 조회하고, exact version ID, `source=wrangler`, 40자리 commit tag, compatibility 설정, SQLite `TradeRecordState` export, staging signer와 세 개의 staging 전용 rate-limit binding만 허용합니다. deployment 검사는 bounded JSON에서 단일 version 100%만 허용합니다. `secret list`만으로는 이미 생성된 특정 version이 실제 상속한 binding을 증명할 수 없으므로 이 검사들을 생략하지 마십시오.

`wrangler secret put`은 새 Worker version을 만들고 즉시 배포하므로 개발자 PC에서 실행하면 승인 gate를 우회합니다. Cloudflare도 이 명령의 즉시 배포 특성과, 배포하지 않고 version만 만드는 `wrangler versions secret put`을 구분합니다([Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)). 모든 production secret 생성·교체는 `production` environment 승인을 받는 전용 GitHub Actions job 안에서만 수행하십시오.

현재 저장소에 environment-protected signer rotation job이 없다면 키를 임의로 바꾸지 마십시오. 먼저 review된 workflow를 추가하고 다음 조건을 만족해야 합니다.

- secret 값은 masked environment secret에서 runner의 임시 파일 또는 표준 입력으로만 전달합니다.
- shell tracing을 끄고 값을 출력하거나 artifact로 올리지 않습니다.
- 새 public key 선배포가 확인되기 전에는 signer secret을 바꾸지 않습니다.
- job은 정확한 `main` SHA와 `production` environment를 사용하고 배포 version에 SHA tag/message를 남깁니다.
- 실패하거나 취소되면 임시 자료가 runner 종료와 함께 폐기되는지 확인합니다.

## 5. 배포, version↔SHA 기록, annotated tag

### 격리 staging 배포

`wrangler versions upload`는 존재하지 않는 Worker를 최초 생성하지 못합니다. 따라서 `bitcoin-p2p-check-staging`이 아직 없을 때만 다음 일회성 bootstrap을 먼저 수행하십시오.

1. 모든 구현 변경을 로컬 commit으로 먼저 고정하십시오. 이 일회성 예외에서는 원격 branch가 provenance가 아니며 `git push`를 실행해서는 안 됩니다. 사용자 보고서와 `.env*`/`.dev.vars*`는 stage하거나 commit하지 마십시오.
2. 원본 저장소에서 고정한 40자리 commit SHA로 detached temporary linked worktree를 만드십시오. linked worktree에는 원본 작업 디렉터리의 untracked 보고서와 무시된 환경 파일이 복사되지 않습니다.
3. 임시 worktree에서 Node.js 22.19.0, `npm ci`, `npm run verify:ci`, clean Git 상태를 순서대로 확인하십시오. 검증이 만든 `dist/client`와 `.wrangler/dry-run/staging`만 사용하며 다른 checkout의 산출물을 복사하지 마십시오.
4. 변경 전에 account ID `dd961adc166c8b6e221e29b7867cb2a3`에만 제한된 bootstrap 전용 credential을 준비하십시오. 배포 credential은 `Workers Scripts Write`만, 별도 identity credential은 `Workers Scripts Read`만 허용하고 다른 account·제품 권한을 부여하지 마십시오. identity credential으로 Cloudflare의 읽기 전용 [Workers subdomain 조회](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/)를 실행하여 workers.dev subdomain이 `thumbking-btc`인지 확인합니다. account ID나 subdomain이 다르거나 조회가 실패하면 mutation 전에 중단하십시오.
5. Cloudflare 변경 창을 단일 운영자로 제한한 뒤 `versions list`와 `deployments list`가 각각 실패하면서 유일한 Cloudflare error code로 `10007`을 반환할 때만 진행하십시오. 한 조회라도 성공하거나 다른 code, 인증·권한·네트워크 오류를 반환하면 bootstrap을 중단하십시오.
6. 아래 명령을 순서 그대로 한 번만 실행하십시오. staging artifact/config guard는 account/subdomain identity를 포함한 모든 검사를 deploy 직전에 다시 실행합니다. Wrangler 4.125.0 output의 `wrangler-session`과 단 하나의 `deploy` event 및 canonical argv를 recorder가 검증하여 신규 result JSON을 exclusive-create한 뒤에만 exact version ID/URL smoke로 진행합니다.

   ```bash
   set -euo pipefail

   SOURCE_REPO="$(git rev-parse --show-toplevel)"
   BOOTSTRAP_COMMIT_SHA="$(git rev-parse HEAD)"
   printf '%s' "$BOOTSTRAP_COMMIT_SHA" | grep -Eq '^[0-9a-f]{40}$'
   test -z "$(git status --porcelain=v1 --untracked-files=no)"

   BOOTSTRAP_ROOT="$(mktemp -d)"
   BOOTSTRAP_WORKTREE="$BOOTSTRAP_ROOT/worktree"
   git -C "$SOURCE_REPO" worktree add --detach "$BOOTSTRAP_WORKTREE" "$BOOTSTRAP_COMMIT_SHA"
   cd "$BOOTSTRAP_WORKTREE"

   test -z "$(git symbolic-ref -q HEAD || true)"
   test "$(git rev-parse HEAD)" = "$BOOTSTRAP_COMMIT_SHA"
   test "$(git cat-file -t HEAD)" = "commit"
   test "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)"
    test ! -e ADVERSARIAL_PRODUCT_AUDIT_2026-08-25.md
    test ! -e AGENTS.md
    test ! -e AUDIT_REPORT_2026-08-25.md
   for isolated_file in .env .env.* .dev.vars .dev.vars.*; do
     test ! -e "$isolated_file"
   done
   test -z "$(git status --porcelain=v1 --untracked-files=all)"

   test "$(node --version)" = "v22.19.0"
   npm ci
   npm run verify:ci
   git diff --check
   test -z "$(git status --porcelain=v1 --untracked-files=all)"
   test "$(npx wrangler --version)" = "4.125.0"

   : "${CLOUDFLARE_API_TOKEN:?account-scoped Workers Scripts Write token is required}"
   : "${CLOUDFLARE_STAGING_IDENTITY_TOKEN:?account-scoped Workers Scripts Read token is required}"
   export CLOUDFLARE_ACCOUNT_ID="dd961adc166c8b6e221e29b7867cb2a3"
   node scripts/check-staging-account.mjs

   APP_VERSION="$(node -p "require('./package.json').version")"
   export BOOTSTRAP_COMMIT_SHA APP_VERSION
   BOOTSTRAP_OUTPUT="$BOOTSTRAP_ROOT/wrangler-output.jsonl"
   BOOTSTRAP_RESULT="$BOOTSTRAP_ROOT/bootstrap-result.json"
   test ! -e "$BOOTSTRAP_OUTPUT"
   test ! -L "$BOOTSTRAP_OUTPUT"
   test ! -e "$BOOTSTRAP_RESULT"
   test ! -L "$BOOTSTRAP_RESULT"

   require_absent_worker() {
     local output status codes
     set +e
     output="$(WRANGLER_WRITE_LOGS=0 WRANGLER_SEND_METRICS=false "$@" 2>&1)"
     status=$?
     set -e
     test "$status" -ne 0
     codes="$(printf '%s\n' "$output" | sed -n 's/.*\[code: \([0-9][0-9]*\)\].*/\1/p')"
     test "$codes" = "10007"
   }

   require_absent_worker npx wrangler versions list \
     --config wrangler.staging.jsonc --json
   require_absent_worker npx wrangler deployments list \
     --config wrangler.staging.jsonc --json

   BOOTSTRAP_DEPLOY_APPROVED=true BOOTSTRAP_COMMIT_SHA="$BOOTSTRAP_COMMIT_SHA" \
   EXPECTED_APP_VERSION="$APP_VERSION" \
     node scripts/check-staging-artifact.mjs --bootstrap
   WRANGLER_OUTPUT_FILE_PATH="$BOOTSTRAP_OUTPUT" WRANGLER_WRITE_LOGS=0 WRANGLER_SEND_METRICS=false \
     npx wrangler deploy .wrangler/dry-run/staging/index.js \
       --no-bundle --upload-source-maps --strict --no-autoconfig \
       --config wrangler.staging.jsonc \
       --tag "$BOOTSTRAP_COMMIT_SHA" \
       --message "Authorized local bootstrap · staging v${APP_VERSION} · $BOOTSTRAP_COMMIT_SHA"

   BOOTSTRAP_COMMIT_SHA="$BOOTSTRAP_COMMIT_SHA" EXPECTED_APP_VERSION="$APP_VERSION" \
     node scripts/record-staging-upload.mjs --bootstrap "$BOOTSTRAP_OUTPUT" "$BOOTSTRAP_RESULT"

   version_id="$(node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(r.version_id)' "$BOOTSTRAP_RESULT")"
   canonical_url="$(node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(r.canonical_url)' "$BOOTSTRAP_RESULT")"
   test "$canonical_url" = "https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev"
   printf '%s' "$version_id" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

   npm run secrets:check:staging
   node scripts/check-worker-version-secrets.mjs staging "$version_id"
   node scripts/check-staging-version.mjs "$version_id" "$BOOTSTRAP_COMMIT_SHA"
   node scripts/check-staging-deployment.mjs assert-single "$version_id"

   EXPECTED_APP_VERSION="$APP_VERSION" EXPECTED_DEPLOYMENT_ENV="staging" \
   EXPECTED_WORKER_TAG="$BOOTSTRAP_COMMIT_SHA" EXPECTED_WORKER_VERSION_ID="$version_id" \
     node scripts/smoke-deployment.mjs "$canonical_url"
   ```

7. `$BOOTSTRAP_RESULT`의 version ID와 canonical URL, commit SHA tag를 배포 증적에 기록하십시오. Wrangler stdout을 복사하거나 임의의 ID·URL로 대체하지 마십시오. 증적을 보존한 뒤 temporary worktree를 제거할 수 있습니다.
8. bootstrap 이후에는 직접 배포 권한을 정상 경로로 사용하지 않고 아래 `workflow_dispatch` 후보 검증·승격 절차만 사용하십시오.

bootstrap은 신규 격리 Worker 생성 예외일 뿐 production Worker의 alias, branch build 또는 기존 staging Worker를 덮어쓰는 절차가 아닙니다. account/subdomain identity 검사는 Worker 부재 검사로 대체할 수 없습니다. preflight 뒤 다른 운영자가 Worker를 만들면 canonical `deploy`가 기존 Worker를 갱신할 수 있으므로 배타적 변경 창이 보장되지 않으면 실행하지 마십시오. deploy가 성공한 뒤 parser나 smoke가 실패하면 같은 명령을 재실행하지 말고 생성된 Worker/version과 보존한 JSONL을 먼저 조사하십시오.

정상 staging 배포도 baseline capture부터 마지막 deployment·branch 재확인까지 단일 운영자 변경 창에서 수행하십시오. 이 구간에는 `staging` branch push, Cloudflare Dashboard/API, 직접 Wrangler 또는 다른 workflow를 통한 `bitcoin-p2p-check-staging` 변경을 금지합니다. GitHub Actions concurrency는 workflow끼리만 직렬화하며 외부 writer를 막지 않고, Cloudflare deployment 생성에는 이 workflow가 사용할 수 있는 compare-and-swap 조건이 없습니다. 따라서 직전 검사와 승격 사이의 경합을 완전히 제거할 수 없으며, 변경 창 위반이나 사후 deployment·branch 불일치는 배포 성공으로 간주하지 말고 즉시 조사하십시오.

1. 원격 `staging`이 배포하려는 정확한 SHA인지 확인합니다.
2. `Verify` workflow를 `staging` ref에서 수동 실행하고 `deploy_staging=true`, `deploy_production=false`를 선택합니다.
3. verify job은 production과 staging dry-run bundle 및 동일 정적 산출물을 보존합니다.
4. deploy-staging job은 최신 원격 `staging` SHA를 다시 확인하고 현재 활성 staging deployment ID와 version 단일 100% 상태를 고정한 뒤 원격 signer secret allowlist를 검사합니다.
5. 보존한 `.verified-staging-worker/index.js`를 `wrangler deploy --no-bundle`로 원자 배포합니다. Durable Object Worker에는 preview URL이 없으므로 `versions upload`나 gradual promotion을 사용하지 않습니다.
6. 배포 직후 exact version ID·source·commit tag·compatibility 설정·SQLite export·전체 binding과 signer allowlist를 확인합니다.
7. canonical staging URL에서 앱 버전, `deploymentEnvironment=staging`, 정확한 Worker version ID, 네 HTML 경로와 전체 asset graph를 smoke합니다.
8. synthetic 조건으로 비공개 기록 생성, pending GET 404, 확정, 공개 GET과 staging 공개키 서명 검증, 철회, 철회 후 GET 404를 확인합니다. capability는 출력하지 않고 실패 시 `finally`에서 철회를 재시도합니다.
9. smoke 뒤 `origin/staging`을 fetch하여 배포 SHA와 같은지 확인하고, 활성 deployment ID와 version 단일 100% 상태가 배포 직후 고정값 그대로인지 다시 검사합니다.

자동 branch build, production Worker preview alias 또는 개발자 PC의 임의 `wrangler deploy`를 이 절차의 대체 경로로 사용하지 마십시오.

### 정상 배포 — 현재 차단됨

현재 `.github/workflows/verify.yml`의 production job은 의도적으로 실패합니다. 다음 조건을 모두 만족하는 별도 변경이 검토·승인·병합되기 전에는 이 차단을 해제하거나 개발자 PC, Cloudflare Dashboard, `npm run deploy:production`, 직접 `wrangler deploy`로 우회하지 마십시오.

Cloudflare의 declarative Durable Object `exports`에는 다음 제약이 있습니다.

- `wrangler versions upload`는 Durable Object lifecycle 변경을 적용하지 않으며, `exports` entry가 있는 구성의 후보 upload 경로로 사용할 수 없습니다.
- `exports`를 사용하는 Worker에는 gradual deployment가 지원되지 않으므로 기존 100% version과 후보 0% version을 함께 둔 뒤 version override로 smoke하는 경로를 사용하면 안 됩니다.
- Durable Object를 구현한 Worker에는 version preview URL이 생성되지 않습니다([Preview URL 제한](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/#limitations)).
- 최초 `TradeRecordState` export 적용은 100% 원자 deployment이고, 그 lifecycle 경계를 지난 뒤에는 이전 version으로 rollback할 수 없습니다([Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/), [rollback 제한](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#bindings)).

따라서 먼저 **별도 승인된 compatibility export bootstrap**을 설계해야 합니다. bootstrap 산출물은 `TradeRecordState` class와 SQLite `exports` 선언을 포함하되 기존 production 요청을 새 Durable Object 저장 경로로 전환하지 않아야 하며, 현재 KV 동작과 응답 계약을 그대로 유지해야 합니다. 이 산출물은 일반 기능 release와 분리된 commit·버전·검증·provenance를 가져야 합니다.

bootstrap 실행 경로는 다음 요건을 모두 코드와 독립 검토로 갖춘 GitHub Actions job이어야 합니다.

1. `production` environment 승인과 production 전용 최소 권한 credential만 사용합니다.
2. 최신 `main` SHA, 검증된 exact static/Worker artifact, 현재 활성 단일 version, production secret 이름·type allowlist를 변경 직전 다시 확인합니다.
3. 검증된 prebundled bundle을 다시 build하지 않고 `wrangler deploy`의 단일 100% 원자 경로로 적용하며, 로컬 실행 가능한 일반 deploy script를 만들지 않습니다.
4. 배포 직후 활성 version ID·Git SHA tag·앱 버전·secret allowlist와 아래 canonical 읽기 전용 smoke를 확인하고, 끝에서 `origin/main`이 여전히 같은 SHA인지 다시 확인합니다.
5. lifecycle 경계를 넘은 뒤 old version rollback이 불가능하므로 사전 격리 환경 검증, forward-fix 담당자와 중단 기준을 승인 전에 확정합니다.

이 bootstrap workflow는 현재 저장소에 존재하지 않습니다. bootstrap이 성공하더라도 `versions upload` 또는 0% gradual 경로를 복원하지 마십시오. declarative `exports` 제약에 맞는 후속 production atomic deployment workflow를 별도로 설계·검토하고, exact deployment/secret 검사와 Git 전후 SHA 검사를 포함한 뒤에만 정상 배포 차단을 해제하십시오.

승인형 atomic 배포 경로가 구현된 뒤의 canonical smoke 합격 기준은 다음과 같습니다.

   | 경로 | 예상 status | media type | `Cache-Control` |
   | --- | --- | --- | --- |
   | `/`, `/install/`, `/privacy/`, `/verify/` | 200 | `text/html` | `public`, `max-age=0`, `must-revalidate`; `immutable` 금지 |
   | `/sw.js` | 200 | `text/javascript` | `no-store`; scope `/` |
   | `/api/market?price=0` | 200 | `application/json` | `no-store` |
   | `/api/version` | 200 | `application/json` | `no-store` |
   | `/api/trade-record/AAAAAAAAAAAAAAAB` | 404 | `application/json` | `no-store` |
   | `/api/unknown` | 404 | `application/json` | `no-store` |

   Cloudflare Workers Static Assets는 기본적으로 정적 asset에 `Cache-Control: public, max-age=0, must-revalidate`와 `Content-Type`을 붙입니다([Static asset headers](https://developers.cloudflare.com/workers/static-assets/headers/)). 이 smoke는 HTML을 512 KiB로 제한해 읽고, 네 HTML 경로에서 시작해 JavaScript 정적·동적 import, CSS `@import`·`url()`, web manifest icon, service worker app shell까지 동일 출처 asset을 최대 128개 재귀 추적하여 status, media type, `nosniff`, fingerprint cache를 검사합니다. 거래 기록 API에는 존재하지 않는 ID를 조회하는 `GET` 한 번만 보내며 어떤 기록도 생성·변경·철회하지 않습니다.

배포 완료 뒤 Cloudflare의 활성 deployment/version을 읽기 전용으로 확인합니다.

   ```bash
   npx wrangler deployments list --config wrangler.jsonc --json
   npx wrangler versions list --config wrangler.jsonc --json
   ```

GitHub Release 또는 변경 기록에 다음 release record를 남깁니다.

   - app version과 annotated Git tag
   - 전체 Git SHA
   - GitHub Actions run URL과 승인자
   - Cloudflare Worker version ID와 version tag
   - 배포·smoke 완료 시각(UTC)
   - 이전 정상 Worker version ID와 rollback SHA

smoke가 성공한 **뒤에만** 배포된 정확한 SHA에 annotated tag를 만들고 push합니다. 기존 tag를 이동하거나 재사용하지 마십시오.

   ```bash
   git tag -a vX.Y.Z <DEPLOYED_FULL_SHA> -m "Production vX.Y.Z; Worker <VERSION_ID>; Actions run <RUN_ID>"
   git push origin vX.Y.Z
   ```

Cloudflare version은 code, assets, binding, compatibility 설정을 기록하지만 Durable Object와 KV 같은 외부 저장소 상태는 포함하지 않습니다([Versions & deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)). 그러므로 Worker rollback과 저장소 복원을 한 작업으로 오해하지 마십시오.

### Rollback

정상 rollback도 새 production 변경입니다. 특히 최초 `exports` bootstrap 전 version으로는 Cloudflare rollback이 금지되므로, 그 lifecycle 경계를 넘은 장애는 검증된 forward-fix로만 처리하십시오. 아래 일반 rollback 절차는 대상 version과 현재 version 사이에 Durable Object lifecycle 변경이 없을 때만 적용합니다.

1. 장애 시각, 증상, 현재 Worker version ID/SHA를 incident에 기록합니다.
2. release record에서 마지막 정상 SHA와 Worker version을 찾습니다.
3. Durable Object namespace, legacy KV, secret, schema, 외부 API가 그 code와 여전히 호환되는지 확인합니다. 삭제되거나 변경된 platform resource는 code rollback으로 복구되지 않습니다.
4. lifecycle-compatible code 변경의 기본 경로는 마지막 정상 변경을 `git revert`하는 PR입니다. `exports` 선언과 provisioned namespace를 제거하거나 과거 상태로 되돌리는 revert는 만들지 마십시오. 최신 `main`에서 검증하고 병합한 뒤 동일한 environment 승인과 smoke를 수행합니다.
5. 새 patch version과 annotated tag를 발행하고 `rolled back from/to` version ID·SHA를 모두 기록합니다.

Cloudflare의 즉시 version rollback이 꼭 필요하면 다음 명령을 **environment-protected GitHub Actions break-glass job 안에서만** 실행하십시오.

```bash
npx wrangler rollback <LAST_GOOD_VERSION_ID> --config wrangler.jsonc --message "incident:<ID> sha:<SHA>" --yes
```

이 명령은 지정 version을 곧바로 활성 deployment로 만들지만 Durable Object lifecycle 경계를 건널 수 없습니다([Cloudflare rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)). 현재 저장소에 승인형 break-glass job이 없으면 로컬이나 대시보드에서 임의 실행하지 말고 lifecycle-compatible forward-fix 또는 검증된 revert 경로를 사용하십시오. 긴급 예외를 허용하는 조직 정책이 별도로 있다면 2인 승인, 전체 감사 기록, 즉시 사후 PR과 key/token 검토를 필수로 하십시오.

## 6. Workers telemetry 비수집, 민감 URL 보호 및 외부 경보

현재 production, staging과 preview 설정은 `observability.enabled`, Workers Logs, invocation log, 자동 trace와 모든 persistence/export destination을 명시적으로 끄고 sampling을 0으로 둡니다. route class와 고정 오류명만 내보내는 애플리케이션 `console` 호출은 소스에 유지하지만 Cloudflare 계정에는 영속화하지 않습니다. `/verify/?id=...`, `/api/trade-record/:id`, Lightning discovery·callback URL의 path/query가 record ID나 수취정보를 포함하며, Cloudflare Observability의 `cf-worker-log` 이벤트도 Worker 호출의 request URL metadata를 포함할 수 있기 때문입니다. 안전한 console payload만으로 플랫폼 enrichment를 통제할 수 없습니다([Workers Observability API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Trace spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)). 실제 저장 필드를 검증한 외부 redacting Tail Worker 또는 OpenTelemetry pipeline을 구성하기 전에는 계정 로그·trace 저장을 활성화하지 마십시오.

### 민감정보 redaction 규칙

소스에 남아 있는 route-class console 호출과 향후 외부 telemetry pipeline은 denylist가 아니라 다음 allowlist 필드만 사용하십시오.

- event 이름
- template화한 route(`trade-record/:id`처럼 실제 ID 제거)
- HTTP method와 status class
- upstream 이름과 실패 종류(`timeout`, `http`, `network`, `invalid`)
- Error class/name
- Worker version ID/tag
- 밀리초 duration과 집계 count

다음 값은 console payload·alert payload·외부 telemetry 저장소에 넣지 마십시오. 향후 계정 로그, trace 또는 외부 telemetry export를 켤 때도 같은 금지 목록을 적용하고, 실제 저장 전에 Cloudflare가 붙인 metadata까지 포함하여 URL path/query를 제거하는 검증된 변환 계층이 없으면 활성화하지 마십시오.

- request/response body와 전체 URL/query string
- 거래 기록 ID, revoke capability/token, token hash
- 비트코인 주소, BIP21, Lightning Address, LNURL, BOLT11
- 거래 금액, 자금 출처, 메모, IP 주소와 모든 request header
- P-256 private JWK, GitHub/Cloudflare token, cookie 또는 인증 header

예외를 그대로 serialize하지 말고 `errorName`과 고정된 오류 코드만 기록하십시오. redaction 로직이 실패하면 원문을 내보내지 말고 해당 event를 버리십시오. 외부 OpenTelemetry/Logpush를 쓸 때는 source와 destination 양쪽에서 URL, query, header, body를 제외하는 allowlist 변환을 적용하고 synthetic 요청으로 실제 수집 필드를 검사하십시오. Cloudflare는 새 telemetry 연동에 OpenTelemetry export를 안내하며 Workers Logpush에는 request/response metadata와 console message가 포함될 수 있다고 설명합니다([Workers observability](https://developers.cloudflare.com/workers/observability/), [Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/)). production에서 `wrangler tail` 같은 실시간 로그도 전체 요청 URL을 노출할 수 있으므로 승인된 incident 조사 외에는 사용하지 말고 출력물을 저장하지 마십시오.

### 초기 경보 기준

트래픽 기준선을 얻기 전의 보수적 시작값입니다. 30일간 데이터를 모은 뒤 완화할 수 있으나, 변경 이유와 승인자를 기록하십시오.

| 지표 | 경고 | 긴급 | 조치 |
| --- | --- | --- | --- |
| 5xx 비율 | 5분간 1% 이상이면서 5건 이상 | 5분간 5% 이상 또는 20건 이상 | 배포 시각/version과 상관관계 확인, upstream과 Worker 오류 구분, rollback 판단 |
| 전체 응답 latency p95 | 10분간 2초 초과 | 5분간 4초 초과 | `/api/market`, 거래 기록, 정적 경로별 외부 synthetic와 집계형 Workers 지표 확인 |
| production 읽기 전용 synthetic | 2회 연속 실패 | 3개 이상 핵심 경로 실패 또는 5분 지속 | 새 배포 중지, 외부 상태와 Worker version 확인 |
| Workers·Durable Objects·KV 관련 quota | 현재 plan 한도의 70% | 현재 plan 한도의 90% | staging/preview·비필수 작업 억제, 증설 또는 원인 제거 |

고정된 무료/유료 한도 숫자를 문서에 복사하지 말고 매월 현재 account plan과 Cloudflare 공식 limits/usage를 기준으로 70%·90% 값을 다시 계산하십시오([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). 5xx에는 애플리케이션 500/503뿐 아니라 exceeded resources와 internal error 결과도 포함하십시오. 계정 로그가 꺼진 동안 5xx와 latency 경보는 집계형 Workers 지표와 외부 synthetic에서 구성하십시오.

### 대시보드 및 외부 시스템 수동 체크리스트

- [ ] 실제 production·staging·preview version에서 account observability, custom/invocation log persistence와 trace persistence가 모두 꺼졌고 export destination이 비어 있는지 확인했습니다.
- [ ] 민감 synthetic 경로 호출 뒤 Workers Logs Query Builder에 새 persistent event가 생기지 않는지 확인했습니다.
- [ ] 집계형 Workers 지표와 외부 synthetic에서 5xx count/rate 및 p50/p95/p99 latency dashboard를 만들었습니다.
- [ ] Cloudflare Notifications에서 계정·billing·platform 경보 중 현재 plan에서 제공되는 항목을 켰습니다.
- [ ] Cloudflare native 기능만으로 위 5xx/latency/quota 조건을 호출할 수 없는 항목은 외부 uptime/metrics 시스템에 구성했습니다.
- [ ] 외부 synthetic는 5분 이하 간격, 최소 2개 지역에서 이 저장소의 읽기 전용 smoke 경로만 검사합니다.
- [ ] email 외에 운영 호출 채널(PagerDuty, Opsgenie 또는 동등 수단)을 연결하고 경고/긴급 escalation을 시험했습니다.
- [ ] OTLP/Logpush/SIEM은 현재 미구성 상태입니다. 활성화 전에 Cloudflare-enriched URL metadata까지 제거하는 field allowlist, 암호화, 접근 권한, 보존 기간과 삭제 요청 절차를 synthetic로 검증했습니다.
- [ ] 경보마다 owner, runbook URL, silence 최대 시간, UTC 점검 시각을 설정했습니다.
- [ ] 매월 quota 70/90% 계산과 수신자 목록을 점검하고, 분기마다 실제 test alert를 발생시켰습니다.

## 7. 거래 기록 상태의 최소 백업과 복원

신규 거래 기록 lifecycle의 authoritative 상태는 record ID별 SQLite Durable Object입니다. `TRADE_RECORDS` KV는 기존 기록의 lazy migration과 rollback 호환을 위한 순서 보장형 비동기 mirror이며, mirror 실패는 이미 성공한 강한 상태 mutation을 실패로 되돌리지 않습니다. 따라서 KV 사본만으로 최신 revoke/finalize 상태를 판정하거나 production을 복원하지 마십시오.

Cloudflare Worker version은 Durable Object 또는 KV 데이터를 보존하거나 rollback하지 않습니다. 거래 기록 상태 백업이 필요하면 Durable Object를 기준으로 별도 승인형 export/복구 설계를 먼저 검증하고, KV는 legacy 호환 보조 사본으로 다루십시오. 이 저장소에는 production backup/export job이 포함되어 있지 않으며 실제 backup 상태도 확인하지 않았습니다.

### 데이터 최소화

- production `TRADE_RECORD_STATE`와 필요한 legacy `TRADE_RECORDS`만 대상으로 하고 다른 KV, Cache API 데이터, 로그, secret을 섞지 않습니다.
- 복원에 필요한 `trade-record:v1:<id>`와 `trade-record:v1:manage:<tokenHash>` entry만 포함합니다.
- Durable Object row의 key/value/absolute expiry와 legacy KV가 반환한 key/value/absolute `expiration`, schema version 외의 운영자 정보나 request metadata를 덧붙이지 않습니다.
- backup은 전송·보관 중 암호화하고 production 운영자와 backup service identity에만 복호화 권한을 부여합니다. 개발자 노트북이나 CI artifact에 내려받지 않습니다.
- snapshot 전체 보존 기간은 그 안의 가장 늦은 원본 만료를 넘지 않으며, 각 record는 자신의 원본 만료를 넘겨 복원 가능하게 보관하지 않습니다.

KV key list의 `expiration`은 처음에 TTL로 저장했더라도 UNIX epoch seconds의 absolute 값으로 반환됩니다([KV list keys](https://developers.cloudflare.com/kv/api/list-keys/)). backup manifest에는 이 값을 그대로 저장하십시오. 복원할 때 새 `expirationTtl: 180일`을 부여하면 보존 기간이 부당하게 연장되므로 금지합니다. KV bulk/단일 write는 absolute `expiration`을 지원합니다([KV expiring keys](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).

### 서명 schema와 보존 정책 변경

`bitcoin-p2p-trade-record/v1`의 `expiresAt`은 `createdAt`으로부터 정확히 15,552,000초(24시간 단위 180일) 뒤이며, 이 관계와 canonical JSON 필드 순서는 이미 발행된 서명의 일부입니다. `app/lib/trade-record.ts`의 버전별 retention policy와 조회 함수가 이 계약의 기준이며, v1 호환 상수도 v1에 고정되어 있습니다.

`bitcoin-p2p-trade-record/v2`의 `expiresAt`은 `createdAt`으로부터 정확히 1,209,600초(14일) 뒤입니다. 신규 발행은 v2를 사용하고, v1과 v2 조회·서명 검증은 각 schema의 원래 만료 시점까지 함께 유지합니다.

보존 기간이나 서명 필드를 변경할 때는 기존 v1 정책·canonicalizer·호환 상수를 수정하지 마십시오. 새 schema 식별자, 별도 retention policy, 별도 canonicalizer를 추가하고 Worker의 신규 발행 schema만 명시적으로 전환하십시오. 배포 전에는 고정 v1 canonical JSON 회귀 테스트, 과거 v1 서명 검증, 새 버전 만료·KV TTL, 두 버전의 동시 조회를 검증해야 합니다. 복원 작업도 record의 schema별 정책을 조회하되 manifest의 기존 absolute `expiration`을 연장해서는 안 됩니다.

### revoke·삭제 전파

복원으로 폐기된 기록을 되살리지 않도록 다음 순서를 지키십시오.

1. 앱의 revoke가 생성하는 management tombstone을 backup job이 우선 수집합니다.
2. tombstone의 record ID에 해당하는 record를 현재 snapshot과 모든 복원 가능 generation에서 삭제합니다.
3. 운영자 수동 삭제는 먼저 승인된 deletion ledger에 key hash와 삭제 시각을 기록한 뒤 Durable Object, legacy KV와 모든 backup generation에 전파합니다. 대시보드에서 흔적 없이 직접 삭제하지 마십시오.
4. 삭제를 물리적으로 즉시 반영하기 어려운 immutable backup은 record별 envelope encryption을 사용하고 해당 record DEK를 파기하여 복원 불가능하게 만듭니다.
5. 삭제 전파가 완료되기 전까지 해당 backup을 복원 가능 상태로 표시하지 않습니다. 삭제 SLA는 24시간 이내로 두고 초과 시 privacy incident로 처리합니다.
6. restore job은 snapshot보다 최신인 deletion ledger를 항상 마지막에 적용하고, tombstone/삭제 대상과 만료된 key를 건너뜁니다.

KV는 eventual consistency 특성이 있으므로 단일 list 차이만으로 삭제를 확정하지 마십시오. authoritative Durable Object의 tombstone/deletion ledger와 propagation window가 지난 KV 재확인 결과를 함께 사용하십시오.

### RPO/RTO와 복원 순서

다음 값은 **복구 도구와 훈련이 구현된 뒤의 목표**이며 현재 달성된 SLO가 아닙니다.

- RPO: 최대 24시간
- RTO: incident 선언 후 4시간 이내 읽기 검증 서비스 복구
- backup 실행: 최소 매일, 실패 시 즉시 호출
- 복원 훈련: 분기 1회, synthetic 데이터만 사용

현재 저장소에는 Durable Object export/import 도구가 없으므로 production 복원 절차는 완성되지 않았습니다. 아래 순서는 구현할 복구 작업의 승인 기준이며, 검증된 DO import 경로 없이 legacy KV만 새 binding으로 연결해 production을 복구하지 마십시오.

1. incident 시점 이전의 최신 정상 snapshot과 그 이후 deletion ledger를 고릅니다.
2. 원본 SHA-256 digest, 서명, object version과 접근 audit를 확인합니다.
3. production이 아닌 격리 Worker의 새 Durable Object namespace와 quarantine KV에 먼저 복원합니다.
4. `expiration <= restore 시작 시각 + 60초`인 entry는 쓰지 않습니다. 나머지는 manifest의 absolute expiry를 그대로 사용합니다.
5. key prefix/schema, record ID 일치, P-256 signature, count, 만료·revoke suppression을 자동 검증합니다. 민감 value를 로그로 출력하지 않습니다.
6. 표본 검증은 synthetic record 또는 hash/count만 사용합니다.
7. 복구 도구가 Durable Object의 authoritative lifecycle과 legacy KV mirror를 같은 결과로 만들고 동시 finalize/revoke/GET 검사를 통과해야 합니다.
8. 새 namespace로의 production binding 변경은 PR, `npm run verify:ci`, 최신 SHA 확인, `production` environment 승인을 거쳐 배포합니다.
9. 읽기 전용 smoke와 기존 유효 record의 검증을 확인한 뒤 incident를 닫습니다. 원본 namespace는 조사·승인 없이 삭제하지 않습니다.

분기 훈련에는 실제 소요 시간, 관측 RPO/RTO, 전체/복원/만료 skip/revoke suppression count, 승인자, 실패 원인과 개선 기한을 남기십시오. 목표를 넘겼다면 다음 release 전에 개선하거나 위험을 명시적으로 수용해야 합니다.

## 8. P-256 `kid` rotation

`kid`는 한번 발행하면 다른 key material에 재사용하지 마십시오. public JWK는 `app/lib/trade-record-verification.ts`의 `TRADE_RECORD_PUBLIC_KEYS`에 포함되고, private JWK는 production secret에만 존재해야 합니다.

### 정기 rotation

1. 승인된 offline key 관리 환경에서 새 P-256 key pair와 고유 `kid`를 만듭니다. private JWK를 출력 로그나 clipboard history에 남기지 않습니다.
2. fingerprint, 생성 시각, 소유자, 예정 signer 전환 시각을 key inventory에 기록합니다.
3. **기존 public key를 제거하지 않고** 새 public JWK를 key map에 추가하는 PR을 먼저 배포합니다.
4. production `/verify/` asset과 새 public key가 배포되었음을 확인하고, PWA 업데이트 전파 시간을 둡니다. 최소 24시간과 조직이 정한 client rollout 기준 중 긴 쪽을 사용하십시오.
5. 별도의 `production` environment 승인형 rotation job에서 signer secret을 새 private JWK로 전환합니다.
6. secret 전환 version의 SHA/Worker version/`kid`를 기록하고 synthetic·비민감 canary로 새 서명을 검증한 뒤 canary record를 revoke합니다. 일반 읽기 전용 smoke는 record를 만들지 않습니다.
7. 이전 public key는 **마지막으로 그 key가 서명한 시각부터 최소 180일**, 그리고 해당 key로 서명된 모든 record의 만료가 끝날 때까지 유지합니다. clock skew와 배포 지연을 고려하여 180일보다 긴 안전 여유를 두십시오.
8. 이전 private key는 rollback 판단 기간 뒤 승인된 key 폐기 절차로 파기합니다. private key를 재사용하여 새 record를 발행하지 않습니다.
9. 이전 public key 제거도 별도 release로 처리하고, 180일+ 조건과 backup의 잔존 record가 모두 끝났다는 증적을 첨부합니다.

### Key compromise

1. security incident를 선언하고 의심 시작·발견 시각, `kid`, 관련 Worker version/SHA, 접근 주체를 기록합니다.
2. production 거래 기록 **생성**을 fail closed로 중지하는 검증된 긴급 변경을 environment 승인 뒤 배포합니다. 기존 KV와 public verification 자료를 삭제하지 마십시오.
3. 안전한 환경에서 새 key pair를 만들고 새 public key를 먼저 배포합니다. public 선배포가 검증되기 전에는 signer를 전환하지 않습니다.
4. 새 private key로 signer를 바꾸는 승인형 배포를 실행하고 새 key canary를 검증한 뒤 생성 기능을 재개합니다.
5. 노출 가능성이 있는 시간대와 old `kid`로 서명된 record 목록을 민감정보 없이 산정합니다.
6. 손상된 public key를 단순 삭제하지 마십시오. 삭제하면 과거 정상 record까지 원인을 알 수 없는 `unknown-key`가 됩니다. client에 compromised `kid`와 영향 시간대를 명시적으로 차단·경고하는 변경을 배포하고, 해당 public key 자체는 감사와 과거 record 식별을 위해 최소 180일+ 유지합니다.
7. 관련 GitHub/Cloudflare credential, 운영자 session과 backup 접근도 조사하고 노출 범위에 포함되면 함께 교체합니다.
8. 법률·개인정보 담당자와 통지 의무를 검토하고, 사용자 공지에는 signature가 거래 사실을 증명하지 않는다는 한계를 포함합니다.
9. 사후 분석에 탐지 지연, 영향을 받은 version↔SHA, rotation 완료 시각, 재발 방지 담당자와 기한을 남깁니다.

## 9. 릴리스 완료 조건

다음 항목이 모두 증적으로 확인되어야 운영 완료입니다.

- [ ] Cloudflare Git 직접 배포와 branch preview가 비활성화되었습니다.
- [ ] 최신 `main` SHA의 verify 성공과 production environment 승인이 확인되었습니다.
- [ ] production/staging/preview Durable Object·KV·signer 격리 및 비프로덕션 fail-closed 테스트가 통과했습니다.
- [ ] 격리 staging 후보와 canonical URL이 동일한 Worker version ID 및 전체 asset graph smoke를 통과했습니다.
- [ ] Worker version↔Git SHA↔Actions run↔annotated tag가 연결되었습니다.
- [ ] 읽기 전용 deployment smoke가 통과했습니다.
- [ ] account 로그·trace persistence 비활성화와 외부 5xx/latency/quota 경보가 실제 synthetic와 test alert로 확인되었습니다.
- [ ] RPO/RTO 안에서 backup 복원 훈련을 완료했습니다.
- [ ] [실기기 릴리스 체크리스트](./release-device-checklist.md)를 완료했습니다.
- [ ] 미완료 법률 검토가 release risk로 승인되었거나 법률 담당자의 배포 승인을 받았습니다.
