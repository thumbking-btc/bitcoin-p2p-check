# P2P 계산기 감사 수정 최종 결과 보고서

- 작성일: 2026-08-26 (Asia/Seoul)
- 대상 프로젝트: `bitcoin-p2p-check` v2.3.0 릴리스 후보
- 작업 브랜치: `codex/production-hardening`
- 최종 검증 커밋: 이 문서가 포함된 원격 `staging` HEAD
- 기준 `main`: `7c50fedf0809bbd057751155072428ddc72648b9`
- 최종 판정: **코드 수정과 격리 스테이징 검증은 완료, 프로덕션 승격은 미승인**

## 1. 결과 요약

제공된 세 감사 보고서의 주장을 소스, 자동시험, Cloudflare 원격 상태와 브라우저 화면으로 다시 판정했습니다. 보고서 문장은 지시로 취급하지 않았으며, 실제로 재현되거나 방어 심층화 가치가 확인된 항목만 수정했습니다.

확인된 제품·보안·배포 문제는 `main`과 현재 프로덕션을 변경하지 않는 별도 브랜치에서 수정했습니다. 수정본은 별도 Cloudflare Worker인 `bitcoin-p2p-check-staging`에 배포하도록 구성했습니다. 이 Worker는 스테이징 전용 P-256 서명 키와 SQLite Durable Object를 사용하므로 생성·비공개 준비·확정·서명 조회·철회까지 실제 사용자 검수가 가능하며, 프로덕션 secret·KV·Durable Object와는 분리됩니다.

다만 코드 수정 완료는 프로덕션 운영 승인과 같지 않습니다. Cloudflare/GitHub 계정 설정, Durable Object 호환성 전환, 키 관리, 백업·복구, 실기기·보조기술 시험과 법률 검토는 외부 완료 조건으로 남아 있습니다. 이 조건들이 충족되기 전까지 프로덕션 배포 workflow는 의도적으로 실패하도록 차단했습니다.

## 2. 범위와 보존 조건

| 구분 | 결과 |
| --- | --- |
| `main` | 수정·병합·배포하지 않음 |
| 프로덕션 Worker | 배포·트래픽 변경·secret 변경하지 않음 |
| 작업 브랜치 | `codex/production-hardening` |
| 원격 저장소 | 검증 완료 후 원격 `staging` 브랜치만 fast-forward push |
| 사용자 제공 보고서 | 수정·스테이징·커밋하지 않음 |
| 검증 환경 | Node.js 22.19.0, Wrangler 4.125.0 |

변경은 제품 로직, Worker 보안, 거래 기록 lifecycle, PWA·접근성, 테스트, 공급망과 배포 통제를 포함합니다.

## 3. 감사 주장 재판정

상세한 항목별 판정은 [감사 수정·재검증 대장](./audit-remediation-2026-08-26.md)에 기록했습니다. 최종 분류는 다음과 같습니다.

### 3.1 사실로 확인되어 수정한 주요 문제

- 프로덕션 Worker의 version preview alias를 별도 스테이징 환경으로 간주할 수 없고 production secret을 상속할 수 있던 격리 문제
- 거래 기록 기능 플래그가 누락된 환경에서 활성화될 수 있던 fail-open 조건
- BOLT11 만료와 120초 공유 경계의 UI·부모 상태 불일치
- 요청·upstream 응답의 무제한 또는 전체 본문 버퍼링과 timeout 부재
- KV eventual consistency로 finalize·revoke·read 순서가 역전될 수 있던 거래 기록 lifecycle
- 철회 capability의 탭 간 덮어쓰기, 확정 응답 유실, 삭제 뒤 부활과 충돌 token 처리 문제
- Lightning Address/LNURL redirect, callback, metadata, payer data와 invoice 검증 경계 부족
- 업비트 시세 신선도·WebSocket watchdog·공유 차단/복구 부족
- 접근성 결과와 시각 결과 불일치 가능성, 320px overflow와 44×44 조작 대상 부족
- PWA offline verify/404 fallback, 서비스 워커 갱신과 비프로덕션 등록 문제
- CSP의 `unsafe-inline`, API 404·cache/security header 불일치
- 검증한 산출물과 실제 배포 산출물의 연결, 배포 경쟁과 Worker version 고정 부족
- GitHub Actions 이동식 tag, SBOM·서드파티 고지·취약점 감사와 릴리스 추적성 부족

### 3.2 부정확하거나 조건부였던 주장

- Lightning 요청이 항상 외부 호출 두 번으로 끝난다는 표현은 redirect를 고려하면 부정확했습니다. 호출 수 대신 hop 수, 동일 host, 전체 deadline과 응답 크기를 제한했습니다.
- Cloudflare Free plan quota가 현재 장애 원인이라는 주장은 계정 사용량 증거가 없어 조건부로 판정했습니다. 용량·70/90% 경보 절차만 마련했습니다.
- native share transient activation, 설치 앱 safe-area·회전, 스크린리더 발화 결과는 코드만으로 확정할 수 없어 실기기 시험 항목으로 남겼습니다.
- 개인정보·가상자산 규제·프로젝트 라이선스 적합성은 기술 감사로 확정하지 않았습니다.

## 4. 완료한 수정

### 4.1 계산·시장 데이터

- 지원 범위 전체에서 정수 비율 계산을 사용하고 UI·서버의 금액·프리미엄 상한을 통일했습니다.
- 10억 원 이상 거래 확인과 1~1,000 sat 극소액 수수료·dust 경고를 추가했습니다.
- 업비트 최근 체결가, 프리미엄과 mempool 수수료 응답을 bounded parser로 검증합니다.
- WebSocket silent watchdog, stale 상태, REST fallback, 화면 복귀와 공유 차단·복구를 구현했습니다.
- 역할·금액 변경 시 결제 정보를 stale 처리하고, 유효한 결제 정보가 있는 동안 금액과 기준 시세를 고정합니다.

### 4.2 Lightning·결제 검증

- Lightning 주소를 ASCII domain, HTTPS/443, local/private 이름과 IP literal 금지 규칙으로 정규화했습니다.
- discovery와 callback을 하나의 12초 deadline 안에서 처리하고 redirect를 0~2회로 제한했습니다.
- LUD-06 metadata, LUD-18 필수 payer data, callback 관계를 callback 전에 검증합니다.
- 응답 BOLT11의 메인넷, 정확한 금액, 만료, 서명과 metadata hash를 Worker에서 확인합니다.
- 만료 즉시 QR·복사를 제거하고 foreground 복귀 및 1초 경계에서 다시 판정합니다.

### 4.3 거래 기록·개인정보·철회

- 생성 → pending → 공유 → finalize와 취소·실패 revoke lifecycle을 분리했습니다.
- 기록별 SQLite Durable Object로 상태를 직렬화하고 KV는 lazy migration·호환 mirror로 한정했습니다.
- 생성·조회·finalize·revoke rate limit을 Durable Object 선택 전에 실행합니다.
- signed absolute expiry, 요청 ID 일치, capability 인증, 멱등 finalize와 revoke를 강제합니다.
- 기록별 브라우저 capability 저장, 다중 탭 동기화, tombstone, 충돌 격리와 bounded recovery scheduler를 추가했습니다.
- 공개 전 수집 항목, 목적, 최대 보관, 공개 범위와 철회 권한을 고지합니다.
- 자금 출처는 로컬 초안에 저장하지 않고 초안은 12시간 후 만료되며 수동 삭제할 수 있습니다.
- 서명이 신원, 입금, 비트코인 수령 또는 거래 완료를 증명하지 않는다는 한계를 생성·검증 화면에 표시합니다.

### 4.4 HTTP·Worker 보안

- 요청과 외부 응답을 엄격한 UTF-8, media type, byte limit와 deadline으로 읽습니다.
- body 초과, stalled stream, timeout과 redirect 실패 시 비차단 방식으로 정리합니다.
- 알 수 없는 `/api/*`는 공통 보안 헤더와 `no-store` JSON 404를 반환합니다.
- HTML CSP는 build 산출물의 script/style hash만 허용하고 `unsafe-inline`을 제거했습니다.
- 민감 record ID와 bearer pathname을 로그 payload에서 제외하고 route class만 남깁니다.
- 거래 기록은 정확히 `production` 또는 격리된 `staging`이고 `TRADE_RECORDS_ENABLED=true`일 때만 활성화됩니다. preview·unknown 환경은 계속 fail closed입니다.

### 4.5 PWA·접근성·사용성

- preview/staging에서는 서비스 워커를 등록하지 않고 기존 등록과 앱 cache를 제거합니다.
- production 서비스 워커 갱신은 사용자 승인 전 `skipWaiting`하지 않습니다.
- verify와 실제 404 shell을 precache하고 API를 cache하지 않으며 알 수 없는 offline URL은 404를 반환합니다.
- 320px 수평 overflow, 44×44 조작 대상, premium label 구조와 WCAG A/AA 자동 검사를 추가했습니다.
- 설치·개인정보·검증 경로, sitemap, robots와 manifest 설명을 정비했습니다.
- 모집글과 거래 기록 카드의 목적, 공개 범위와 결제 QR을 분리했습니다.

### 4.6 공급망·CI·배포

- 앱과 Worker runtime typecheck, Node 시험, 세 Worker 환경 시험, Playwright·axe·PWA 시험을 통합 gate로 구성했습니다.
- GitHub Actions를 전체 commit SHA로 고정하고 Dependabot, CycloneDX SBOM, provenance attestation과 서드파티 고지를 추가했습니다.
- clean `npm ci`, lockfile 일치, notices, types, 세 Wrangler 구성 dry-run과 high-severity audit를 강제합니다.
- staging은 별도 Worker, exact binding·secret allowlist, commit tag와 단일 100% deployment를 확인합니다.
- SQLite Durable Object export가 있는 staging은 Cloudflare 제약에 따라 version Preview를 만들지 않고, 검증된 산출물을 원자적으로 직접 배포한 뒤 canonical URL에서 전체 lifecycle을 synthetic 데이터로 검사합니다.
- production은 Durable Object declarative `exports`와 호환되는 전환·원자 배포 경로가 마련될 때까지 fail closed 처리했습니다.

## 5. 실제 스테이징 결과

| 항목 | 확인값 |
| --- | --- |
| canonical URL | `https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev/` |
| Worker | `bitcoin-p2p-check-staging` |
| 앱 버전 | `2.3.0` |
| 배포 환경 | `staging` |
| Git commit tag | 원격 `staging` HEAD와 일치하도록 검사 |
| Worker version ID | `/api/version` 응답과 Cloudflare deployment에서 일치하도록 검사 |
| 트래픽 | 검증 version 단일 100% |
| 원격 secret | `TRADE_RECORD_SIGNING_KEY` 정확히 1개 |
| 거래 기록 저장소 | 스테이징 전용 SQLite `TradeRecordState` Durable Object |
| 거래 기록 | `TRADE_RECORDS_ENABLED=true` |
| 화면 표식 | `STAGING`, 실제 거래 사용 금지 안내 및 공유 이미지 watermark |

초기에 안내한 `bitcoin-p2p-check-preview.thumbking-btc.workers.dev` 주소는 별도 스테이징 Worker가 아니라 production Worker 쪽 version preview alias였습니다. 해당 주소는 스테이징으로 사용하지 않았고, 위 canonical staging Worker로 교정했습니다.

배포와 검증은 다음 순서로 수행합니다.

1. 기존 staging deployment와 version을 단일 100% 상태로 고정
2. 기존 Worker와 선택 version의 remote secret exact allowlist 확인
3. 검증된 commit 산출물을 별도 staging Worker에 원자적으로 직접 배포
4. 배포 version의 exact config, Durable Object export, bindings, secret과 commit tag 확인
5. canonical staging에서 exact version·전체 endpoint/asset smoke 실행
6. synthetic 거래 기록의 생성·비공개·확정·서명 조회·철회와 최종 404 확인
7. 원격 `staging` SHA, 배포 ID와 단일 100% traffic 상태 재확인
8. 브라우저에서 `STAGING` 표식, 실제 거래 사용 금지 안내와 공유 흐름 확인

## 6. 최종 검증 증적

Node.js 22.19.0과 고정된 Wrangler 4.125.0에서 변경 범위에 맞는 정적·런타임·브라우저 검증을 실행했습니다.

| 검증 | 결과 |
| --- | --- |
| ESLint | 통과 |
| 앱 TypeScript | 통과 |
| Worker runtime TypeScript | 통과 |
| 서드파티 notices 일치 | 8개 잠금 runtime package 통과 |
| Node 시험 | 226/226 통과 |
| production Worker runtime | 16/16 통과 |
| staging Worker runtime | 4/4 통과 |
| preview Worker runtime | 4/4 통과 |
| Chromium E2E·접근성·PWA | 관련 시험 통과. Windows 로컬 Wrangler 프록시가 장시간 전체 실행 중 종료되어 전체 21개 연속 재실행은 환경 실패로 중단 |
| Worker types | 최신 상태 확인 |
| production/staging/preview dry-run | 모두 통과 |
| npm audit | 취약점 0건 |
| version Preview 집중 회귀시험 | 45/45 통과 |
| 독립 보안 재검토 | 잔여 P1/P2 없음 |
| canonical staging remote smoke | 배포 후 실행 |
| synthetic 거래 기록 lifecycle smoke | 배포 후 실행 |
| 최종 staging deployment | 배포 후 exact version 단일 100% 확인 |

정적 원격 smoke는 `/api/version`, 네 페이지 경로, 서비스 워커, 시장 API, 존재하지 않는 거래 기록 조회, API 404와 HTML이 참조하는 동일 origin의 JavaScript·CSS·manifest·이미지 전체 graph를 검사합니다. 별도의 승인 guard가 있는 stateful smoke는 synthetic 데이터 한 건만 생성하여 pending 비공개, finalize, staging 공개 키 서명 검증, revoke와 최종 404까지 확인하며 capability를 출력하지 않습니다.

## 7. 남아 있는 프로덕션 차단 조건

다음 조건은 코드 branch 밖의 권한·운영·전문 판단이 필요합니다. 완료 증거가 없으므로 프로덕션 승격을 승인하지 않습니다.

1. Cloudflare Git 직접 배포 연결 해제
2. production Worker에 남아 있는 과거 `staging` alias/version 폐기와 signer 노출 범위 평가·필요 시 rotation
3. GitHub `main` 보호, 필수 verify, production reviewer와 최소권한 environment secret 구성
4. Durable Object compatibility export bootstrap artifact와 보호된 100% atomic bootstrap job 검증
5. declarative `exports` 제약을 준수하는 후속 production atomic workflow와 배포 전후 exact SHA/deployment/secret 검사
6. account log·trace persistence 비활성화 실측, URL metadata 제거 pipeline과 synthetic·5xx·latency·quota test alert
7. 암호화 backup 목적지, service identity, 삭제 ledger와 quarantine restore 훈련
8. signer private-key 보관·승인형 rotation·침해 대응 훈련
9. iPhone Safari, Android Chrome, Windows 설치·회전·offline·native share 실기기 시험
10. NVDA, VoiceOver, TalkBack 실제 발화 시험
11. 프로젝트 권리·라이선스, 개인정보·가상자산 규제 범위와 사용자 고지 전문 검토
12. 동일 산출물의 승인된 production 배포와 smoke 성공 후 annotated tag·release record 생성

운영 절차는 [프로덕션 운영 런북](./production-operations.md), 실기기 항목은 [릴리스 기기 체크리스트](./release-device-checklist.md), 릴리스 증적은 [릴리스 거버넌스](../RELEASE_GOVERNANCE.md)를 따릅니다.

## 8. 최종 결론

`codex/production-hardening`의 수정본은 제공된 감사 보고서에서 코드로 해결할 수 있고 실제로 확인된 문제를 반영했습니다. 스테이징은 프로덕션 상태와 비밀을 재사용하지 않는 별도 Worker에서 전체 거래 기록 흐름을 검수할 수 있도록 구성했습니다.

현재 승인 가능한 범위는 **브랜치 코드 검토와 격리 스테이징 사용자 검수**까지입니다. `main` 병합과 프로덕션 배포는 위 외부 차단 조건이 완료되고 별도 승인을 받은 뒤 진행해야 합니다.
