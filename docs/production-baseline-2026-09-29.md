# Production 원본 확인 — 2026-09-29

2026-09-29 KST에 production을 읽기 전용으로 조회했습니다. 배포, secret 변경, 기록 생성·변경·삭제는 수행하지 않았습니다. 이 기록은 배포 승인이 아니며, `.github/workflows/verify.yml`의 production 차단을 유지합니다.

## 확인한 활성 상태

Wrangler **4.136.1**과 명시적 `wrangler.jsonc`로 deployment 목록 및 정확한 version을 조회했습니다. 목록의 배열 위치 대신 `created_on`을 비교하여 최신 deployment를 선택했습니다.

| 항목 | 실측값 |
| --- | --- |
| Worker | `bitcoin-p2p-check` |
| 활성 deployment | `9ec7e49a-017e-40ec-b92b-42ef7f9c26e0` |
| 활성 version | `44ac3cbb-ef30-43a1-aebb-b32bb029c605` / number `407` |
| 트래픽 | 위 version 단일 100% |
| deployment 시각 | `2026-08-31T14:44:08.669207Z` |
| source / 생성 trigger | `wrangler` / `version_upload` |
| source SHA tag / message | 둘 다 없음 |
| compatibility | `2026-05-22`, `nodejs_compat` |
| Durable Object exports | version runtime metadata에 없음 |
| version preview | `has_preview: true` |
| binding 이름·type | `TRADE_RECORD_CREATE_RATE_LIMITER` (`ratelimit`), `TRADE_RECORDS` (`kv_namespace`), `TRADE_RECORD_SIGNING_KEY` (`secret_text`) |
| exact version secret allowlist | 통과. secret 값이나 signing key fingerprint의 검증은 아님 |
| 정적 자산 | Static Assets 사용, `auto-trailing-slash`, `404-page`, `/api/*`만 Worker 우선 실행 |

활성 version의 script ETag는 `7eee60271a264ddd1b2cd6b8d1f73b0f3d1ca4b885ffc817848b80461214a562`입니다. 이는 Git SHA가 아닙니다. `origin/main`의 `ca735db062f1c7fd6eceab3f6a86c01b20fada45`와 시점이 가깝다는 사실만으로 배포 원본의 일치를 주장하지 않습니다.

## 최신 script와 활성 version을 구분한 복원

공식 [Get Worker Script Content API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/)인 `GET /accounts/{account}/workers/scripts/{name}/content/v2`를 먼저 확인했습니다. 응답은 200이었지만 ETag가 `536498500b4b646e384c5014ba8d104f1c0b5b56695d4c14ef769e06ed7fc05f`로 활성 version과 달랐습니다. 요청 전후 활성 deployment는 동일했습니다. 이 응답을 production 원본으로 취급하거나 해당 코드 바이트를 보존하지 않았습니다. Worker 이름으로 내려받은 최신 script를 활성 deployment의 코드라고 가정하면 안 됩니다.

이후 공식 [Get Worker Version API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/)를 사용했습니다.

```text
GET /accounts/{account}/workers/workers/bitcoin-p2p-check/versions/44ac3cbb-ef30-43a1-aebb-b32bb029c605?include=modules
```

이 API는 `worker_id`에 이름을 허용하고 `include=modules`로 코드·sourcemap 내용을 반환합니다. 반환된 **exact UUID, version number, compatibility date·flags**를 Wrangler 조회와 대조했고, 조회 전후 활성 deployment도 같았습니다. 2026-09-28 16:54:38 UTC에 **46개 module**을 로컬에 보존했습니다. 이 응답에는 sourcemap module이 없었습니다.

| 복원한 main module | 값 |
| --- | --- |
| 이름 | `index.js` |
| 크기 | 305,029 bytes |
| SHA-256 | `26c0c11181a78b84c531c1dd11f68cb42200ecaf136b0426829cfe850360c0b1` |

이 exact-version API는 HTTP ETag를 반환하지 않았습니다. 따라서 복원 module의 정체성은 **요청·응답 version ID 및 runtime 대조와 활성 deployment 불변 확인**으로 연결했습니다. ETag 일치, 원래 Git SHA, 재현 가능한 원래 빌드, 전체 정적 asset의 동일성까지 검증했다고 표현하지 않습니다.

인증은 공식 [`wrangler auth token --json`](https://developers.cloudflare.com/changelog/post/2025-12-18-wrangler-auth-token/)의 출력을 짧은 로컬 프로세스 메모리에서만 사용했습니다. 알려진 account·Worker와 공식 GET endpoint로 범위를 고정했고, redirect를 금지했으며, 30초 timeout과 8 MiB 응답 상한을 적용했습니다. credential 파일을 탐색하지 않았고 token·secret 값·raw API envelope·asset JWT를 출력하거나 보존하지 않았습니다. 내려받은 module은 실행하지 않았습니다.

## 로컬 증적

아래 파일은 모두 Git에서 무시되는 `outputs/validation/` 안에 있습니다. 원격 metadata에는 개인 식별정보가 포함될 수 있으므로 raw 파일을 저장소나 공개 release에 첨부하지 않습니다.

- `production-deployments-20260929.json`: production deployment 조회 원본.
- `production-version-20260929.json`: 활성 exact version metadata 원본.
- `production-baseline-summary-20260929.json`: 민감한 값을 제외한 상태·제약 요약.
- `production-active-source-summary-20260929.json`: 최신 content endpoint의 ETag 불일치 증적.
- `production-exact-version-source-summary-20260929.json`: exact version 연결, module 이름·크기·SHA-256 목록.
- `production-exact-version-module-1-20260929.bin`부터 `-46-20260929.bin`: 복원 module. main `index.js`는 `-27-20260929.bin`입니다.
- `inspect-production-source-20260929.mjs`: 인증값을 저장하지 않는 로컬 조회 helper. 마지막 실행은 exact-version API를 사용했습니다.

## 남은 최소 작업

1. 복원 module의 digest를 고정하고 실제 API 계약을 검토합니다. 원래 Git SHA를 별도로 입증하거나, 불명확성을 명시한 복원 원본을 새로운 기준 산출물로 독립 검토해야 합니다.
2. 동일 활성 version이 제공하는 전체 정적 asset과 설정을 확보·대조합니다. 46개 Worker module의 복원만으로 browser asset 전체가 복원된 것은 아닙니다.
3. 실제 원본 요청·KV 동작·정적 asset을 보존하는 별도 compatibility bootstrap을 만들고, `TradeRecordState` class/export만 도입했음을 로컬 계약 테스트와 격리 환경에서 확인합니다. 현재 후보의 `allowLegacyKv`는 새 capability·schema·보관 정책까지 적용하므로 이전 요청 계약을 보존하는 대체 수단이 아닙니다.
4. Git 연결·기존 preview·secret 노출 범위·GitHub 보호와 environment reviewer를 계정에서 확인하고, lifecycle 경계 이후 forward-fix 담당자와 승인 조건을 정합니다. 이번 source 조회는 이 운영 항목들을 확인한 것이 아닙니다.
5. [프로덕션 운영 런북](./production-operations.md)의 동일 artifact, exact deployment·secret 검사, 최신 main SHA 전후 검사, 읽기 전용 smoke를 포함한 승인형 atomic bootstrap과 후속 release 경로를 별도로 검토합니다. 공개 배포와 원격 변경은 수행하지 않습니다.
