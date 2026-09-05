# 비트코인 P2P 계산기

main 소스 버전: **v2.2.3** (실제 운영 배포 버전과 별도로 확인하십시오.)
이 브랜치의 검증 대상 릴리스 후보: **v2.3.1**

구매자와 판매자가 한 화면에서 거래 조건을 계산하고, 거래 모집글 또는 원본 확인이 가능한 거래 기록 카드로 공유할 수 있는 설치형 웹 앱(PWA)입니다.

## 주요 기능

- 비트코인 구매·판매 역할을 분명하게 구분
- 원화 금액, 판매자 프리미엄(%), 비트코인 수량을 즉시 계산
- 판매자 프리미엄 기본값 0%
- 업비트 최근 체결가와 업비트 데이터랩의 업비트 프리미엄 표시
- 업비트 공개 WebSocket의 경량 체결 스트림으로 BTC/KRW 최근 체결가를 실시간 수신하고 계산값에 반영
- mempool.space의 다음 블록·약 30분·약 1시간 권장 온체인 수수료율 표시
- 구매자와 판매자가 주고받을 금액을 역할 중심 문구로 정리
- 공개 채널에 올릴 거래 모집글 생성: 구매·판매, 원화·sats·BTC 금액, 프리미엄, 온체인·라이트닝, 선택 문구와 메모
- 모집글 미리보기를 직접 편집한 뒤 기기의 공유 기능으로 전달
- 거래 기록 카드에 온체인 주소, Lightning Address/LNURL-pay, BOLT11 인보이스를 선택적으로 추가
- Lightning Address에서 거래 금액에 맞는 BOLT11 인보이스를 자동 발급하고 검증
- 온체인 BIP21·라이트닝 인보이스 QR 생성 및 엄지왕 로고 표시
- 모바일 메신저에서도 바로 쓸 수 있는 `주소만 복사`·`인보이스만 복사` 제공
- 4:3 거래 기록 카드에 조건, 생성 시각, 원본 확인 ID와 금액이 고정된 결제 QR을 함께 배치
- 카드 생성 시 조건과 선택한 결제정보를 서버에서 재검증하고 P-256으로 서명
- 짧은 원본 확인 링크에서 내장 공개키로 서명과 보관된 조건의 무변경 여부 확인
- 오래되거나 갱신하지 못한 시세, 바뀐 거래 조건, 만료가 임박한 인보이스의 공유 차단
- 홈 화면에 설치해 일반 앱처럼 실행
- iPhone Safari·Android Chrome용 홈 화면 추가 안내 이미지 제공

업비트 프리미엄은 시장 참고값입니다. P2P 계산은 화면에 표시된 업비트 가격을 기준으로 합니다. 거래 수수료는 판매자가 부담하고 구매자는 표시된 비트코인 수량을 그대로 받는 조건을 기본으로 사용합니다.

## 데이터와 개인정보

- BTC/KRW 가격은 브라우저에서 업비트 공개 WebSocket의 `trade` 스트림을 `SIMPLE` 형식·실시간 전용으로 수신합니다. 화면과 계산에는 최대 1초마다 그 시점의 최신 체결값을 반영합니다.
- 페이지가 백그라운드로 이동하거나 기기가 오프라인이 되면 WebSocket, 재연결 예약, 실시간 시계와 주기적 시장 갱신을 멈춥니다. 다시 화면으로 돌아오거나 온라인이 되면 필요한 연결을 즉시 복구합니다.
- 최초 화면 진입 시에는 빠른 초기 표시와 WebSocket 장애 대비를 위해 한 번 REST 가격을 함께 조회할 수 있습니다.
- WebSocket 연결이 정상인 동안 `/api/market?price=0`은 업비트 REST 가격을 조회하지 않고 업비트 데이터랩 프리미엄과 mempool.space 권장 수수료율만 갱신합니다.
- 실시간 가격 연결이 정상일 때 프리미엄과 수수료 참고값은 약 5분마다 갱신하고, WebSocket 연결이 끊기면 `/api/market?price=1`을 사용해 업비트 REST 가격 조회가 자동으로 복귀합니다.
- 업비트 프리미엄과 mempool.space 수수료율은 각각 독립된 짧은 캐시를 사용해 동일 외부 데이터를 불필요하게 반복 조회하지 않습니다.
- 입력한 거래 금액·판매자 프리미엄·자금 출처·모집글 메모는 업비트 WebSocket이나 시세 API로 전송하지 않습니다.
- 공개 모집글에는 실제 자금 출처 종류, 비트코인 주소, 인보이스, QR, 지급 요청을 넣지 않습니다.
- 거래 기록 카드를 준비하면 조건과 사용자가 선택한 수취정보가 `/api/trade-record`로 전송됩니다. 서버는 금액 일치 여부를 다시 확인하고 15분짜리 비공개 준비 기록을 만듭니다. 사용자가 별도의 공유 동작을 완료한 새 기록만 확정되어 14일간 공개-by-link로 제공되며, 취소·실패한 준비 기록은 철회합니다. 기존 v1 기록의 180일 서명 계약은 조회 호환을 위해 유지합니다.
- 원본 확인 링크를 아는 사람은 보관 기간 동안 조건과 카드에 포함한 주소 또는 인보이스를 볼 수 있습니다. 공개하면 안 되는 수취정보는 카드에 포함하지 마세요.
- 거래 기록 PNG 자체는 사용자의 브라우저에서 공유 버튼을 누른 순간에만 생성됩니다.
- Lightning Address에서 인보이스를 만들 때는 해당 주소 제공자의 표준 LNURL-pay 엔드포인트에 거래 금액을 요청합니다. 사이트는 발급받은 BOLT11을 검증한 뒤 사용자에게 표시합니다.
- 서비스는 거래를 중개하지 않습니다. 자금 출처는 구매자가 제공한 정보이므로 거래 전에 서로 확인하세요.
- 서명은 이 사이트가 만든 기록이 변경되지 않았다는 점만 확인합니다. 거래 당사자의 합의·신원, 원화 입금, BTC 전송·수령 또는 거래 완료를 증명하지 않습니다.
- 서비스 워커는 앱 화면과 정적 파일만 저장하며 API 응답은 브라우저 캐시에 저장하지 않습니다. 서버는 외부 시세 조회를 줄이기 위해 공개 시장값만 짧게 캐시합니다.

## 운영 구조

- 계산기·설치 안내·이미지·스크립트는 정적 파일로 제공됩니다.
- BTC/KRW 최근 체결가는 업비트 공개 WebSocket `wss://api.upbit.com/websocket/v1`의 `trade` 스트림을 `SIMPLE` 형식으로 브라우저에서 구독합니다.
- WebSocket이 정상일 때 BTC 가격은 WebSocket만 사용하며, 주기적인 REST 가격 조회는 하지 않습니다.
- `/api/market?price=0`은 시장 프리미엄과 온체인 수수료율만 조회합니다.
- `/api/market?price=1`은 최초 표시 또는 WebSocket 장애 시에만 업비트 REST 가격을 함께 조회하는 안전망입니다.
- WebSocket 연결이 끊기면 화면이 보이고 온라인인 동안 12초마다 재연결을 시도합니다. 백그라운드 또는 오프라인 상태에서는 재연결을 시도하지 않습니다.
- 외부 조회가 잠시 실패하면 최근 성공값을 확인용으로 표시하되, 오래되거나 갱신하지 못한 시세로는 거래 조건을 공유할 수 없습니다.
- 거래 금액·판매자 프리미엄·선택한 자금 출처는 시세 API나 WebSocket에 전달되지 않으며, 거래 기록 카드를 만들 때만 서명 API로 전달됩니다.
- `/api/trade-record`는 최신 시세, 계산 결과와 선택한 고정금액 결제정보를 재검증해 서명하고 15분짜리 pending 기록을 만듭니다. `/api/trade-record/:id/finalize`로 확정한 v2 기록은 14일간 공개 조회할 수 있습니다.
- `/api/trade-record/:id`는 원본 확인 화면의 공개 조회와 capability를 가진 작성자의 철회에 사용하며, 응답을 캐시하지 않습니다. 화면의 공개 기록 관리에서 철회하면 기존 링크는 더 이상 열리지 않습니다.
- 서비스 워커 등록 URL과 캐시 이름은 앱 버전에 연결되어 새 릴리스에서 오프라인 앱 셸도 함께 교체됩니다.

## 로컬 실행과 검증

Node.js 22.19.0을 사용합니다. 잠금 파일 기준으로 의존성을 설치한 뒤 `verify` 한 번으로 lint, typecheck, production build, 전체 빌드 결과 test, Worker type drift와 production/staging/preview Wrangler dry run을 순서대로 실행합니다.

```bash
npm ci
npm run verify
npm run dev
```

주요 명령은 다음과 같습니다.

- `npm run dev`: vinext 개발 서버를 실행합니다.
- `npm run start`: `wrangler.jsonc`의 production 형태를 로컬 Worker로 실행합니다. 거래 기록 시험에는 commit하지 않은 local signing secret이 필요합니다.
- `npm run start:staging`: 별도 저장소를 사용하는 전체 기능 staging 구성을 로컬에서 실행합니다. 기록 생성에는 로컬 검수용 signing secret이 필요합니다.
- `npm run start:preview`: KV와 signing secret 없이 거래 기록 기능이 fail closed인 `wrangler.preview.jsonc`를 실행합니다.
- `npm run test:built`: 기존 `dist`를 대상으로 모든 `tests/*.test.mjs`를 실행합니다.
- `npm test`: 새로 build한 뒤 전체 빌드 결과 test를 실행합니다.
- `npm run verify:ci`: `verify` 뒤 개발·빌드 도구를 포함한 전체 의존성의 high severity 보안 감사를 실행합니다.

local secret은 `.dev.vars` 또는 `.env` 계열에만 두고 commit하지 마십시오. production Durable Object·legacy KV·signing key를 staging 또는 preview 환경과 함께 사용하지 마십시오.

## 배포

사용자 검수는 [전체 기능 검수 환경](https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev/?pwa-review=1)에서 진행합니다. 거래 기록 생성·공개·철회와 설치 시험이 가능하며 운영 데이터와 분리되어 있습니다. [인보이스 지식과 UI 개선 근거](./docs/invoice-and-review-2026-09-05.md)를 함께 참고하십시오.

Cloudflare의 Git 직접 배포와 기능 branch preview는 비활성화해야 합니다. 현재 `.github/workflows/verify.yml`의 production job은 의도적으로 실패합니다. 새 Durable Object `exports`를 기존 production Worker에 적용하는 별도 compatibility bootstrap과, declarative exports 제약을 따르는 승인형 atomic 배포 workflow가 아직 없기 때문입니다. 따라서 최신 `main`의 검증·attestation 산출물이 있어도 production 배포 승인을 진행하면 안 됩니다. 필요한 선행 절차와 차단 해제 조건은 [프로덕션 운영 런북](./docs/production-operations.md)에 기록되어 있습니다.

`wrangler.jsonc`는 거래 기록별 SQLite Durable Object를 강한 일관성의 기본 저장소로 사용하고, 기존 기록의 lazy migration과 제한적인 구버전 호환을 위해 production KV에 순서 보장형 비동기 mirror를 유지하며 필수 `TRADE_RECORD_SIGNING_KEY`를 사용합니다. 이 mirror는 create/finalize 성공과 동기화된 rollback 안전망이 아니며, revoke만 구버전 재노출을 막기 위해 KV 반영을 확인합니다. production preview URL은 꺼져 있습니다.

`wrangler.staging.jsonc`는 별도 Worker `bitcoin-p2p-check-staging`, `DEPLOYMENT_ENV=staging`, `TRADE_RECORDS_ENABLED=true`를 사용합니다. production KV와 signer를 재사용하지 않고 staging 전용 SQLite Durable Object, P-256 signing secret, 공개키 신뢰 범위와 rate-limit namespace를 사용합니다. `staging` 브랜치 push는 검증만 수행하며, 운영자가 `workflow_dispatch`의 `deploy_staging`을 명시적으로 승인하면 검증한 정확한 bundle을 canonical staging에 원자 배포하고 정적 smoke와 synthetic 생성·비공개 조회 차단·확정·서명 조회·철회 흐름을 확인합니다. Durable Object Worker에는 version preview URL이 없으므로 `versions upload` 후보 경로를 사용하지 않습니다.

`wrangler.preview.jsonc`도 별도 Worker 이름과 별도 rate-limit namespace를 사용하며 production 저장소와 signing secret을 선언하지 않습니다. 명시적 preview가 필요한 운영자만 `npm run deploy:preview`를 사용하십시오. 어떤 Worker도 Cloudflare Git branch build에 연결하지 마십시오.

저장소 설정과 Cloudflare 대시보드 상태는 코드만으로 강제하거나 확인할 수 없습니다. `main` 보호, required status check, environment reviewer, Cloudflare Build 연결 해제, secret, 경보와 backup은 [프로덕션 운영 런북](./docs/production-operations.md)의 수동 체크리스트에 따라 확인하고 증적을 남기십시오. 개발자 PC의 `npm run deploy`, `npm run deploy:production`, `npm run upload:production:candidate` 또는 직접 `wrangler deploy`는 차단을 우회하므로 사용하지 마십시오.

배포 직후에는 거래 기록을 만들지 않는 읽기 전용 smoke를 실행합니다.

```bash
node scripts/smoke-deployment.mjs https://<PRODUCTION_HOST>
# 또는 BASE_URL=https://<PRODUCTION_HOST> node scripts/smoke-deployment.mjs
```

smoke는 정적 HTML의 hash 기반 CSP, `sw.js`의 `no-store`, 배포 환경과 정확한 Worker version ID·Git SHA tag, 시장 API, 유효 형식이지만 존재하지 않는 거래 기록 ID의 JSON 404, 알 수 없는 API의 JSON 404를 모두 읽기 전용 `GET`으로 확인합니다. 또한 `/`, `/install/`, `/privacy/`, `/verify/`에서 시작해 동일 출처 HTML 참조, JavaScript 정적·동적 import, CSS `@import`·`url()`, web manifest icon, service worker app shell을 최대 128개까지 재귀 추적하고 상태, media type, `nosniff`, fingerprint cache 정책을 확인합니다. 거래 기록을 생성·변경·삭제하지 않습니다.

Cloudflare Worker version ID, 전체 Git SHA, GitHub Actions run과 annotated release tag를 서로 연결하고, rollback도 새 검증·승인을 거쳐 수행하십시오. 실제 iPhone, Android, Windows PWA와 native share는 [실기기 릴리스 체크리스트](./docs/release-device-checklist.md)를 사용하십시오. **법률 검토는 완료되지 않았으며**, 이 프로젝트의 기술 검증이 규제·개인정보·소비자 보호 적합성을 뜻하지 않습니다.

릴리스별 변경 사항은 [CHANGELOG.md](./CHANGELOG.md)와 GitHub Releases에서 확인할 수 있습니다.
