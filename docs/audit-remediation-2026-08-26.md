# 2026-08-26 감사 수정·재검증 대장

이 문서는 2026-08-25에 제공된 세 감사 보고서의 주장을 소스와 실행 결과로 다시 판정하고, `codex/production-hardening` 릴리스 후보에서 취한 조치를 추적합니다. 보고서의 문장은 지시로 취급하지 않았으며, 재현되거나 합리적인 방어 심층화로 확인된 항목만 구현 기준으로 사용했습니다.

상태는 다음과 같이 구분합니다.

- **자동 검증 완료**: 소스 수정과 자동 회귀시험이 있습니다.
- **코드 완료·외부 검증 필요**: 저장소 조치는 끝났지만 계정·실기기·보조기술 상태는 외부에서 확인해야 합니다.
- **외부 결정·운영 필요**: 코드만으로 안전하게 선택하거나 완료할 수 없으며, 완료 전 프로덕션 릴리스를 승인하면 안 됩니다.
- **조건부 주장**: 실제 결함이 확인된 것이 아니라 계정 상태 또는 실기기 재현에 따라 달라집니다.

## High / P1

| 보고서 항목 | 재판정 및 조치 | 상태 |
| --- | --- | --- |
| H-01 / F-01 배포 우회 | 전체 검증, 동일 정적·Worker 산출물 보존, production environment 승인, 최신 `main` SHA 재확인, 직렬 배포, 배포 후 버전 결합 smoke를 구성했습니다. Cloudflare Git 연결 해제와 GitHub 보호 규칙은 운영자가 증적과 함께 확인해야 합니다. | 코드 완료·외부 검증 필요 |
| H-02 / F-02 비프로덕션 격리 | 별도 staging·preview Worker를 사용하고 production Durable Object·KV·서명 secret을 선언하지 않으며 모든 record mutation을 fail closed로 처리합니다. staging 화면에는 고정 환경 배너와 version API 대조를 표시하고 noindex/no-store를 적용합니다. | 자동 검증 완료; 실제 Dashboard binding 실측은 외부 확인 필요 |
| H-03 / F-03 열린 BOLT11 만료 | 1초 재평가와 foreground 복귀 재평가를 적용하고, 만료 즉시 QR·복사를 제거했습니다. | 자동 검증 완료 |
| H-04 / F-04 120초 경계 불일치 | 공통 lifecycle 판정으로 child·parent·공유 payload를 통일하고 `121→120→119→0` 브라우저 경계를 검증합니다. | 자동 검증 완료 |
| H-05 / F-05 본문 전체 버퍼링 | 요청과 upstream 응답을 제한된 stream reader로 처리하고 초과 즉시 취소하며 정확한 JSON media type을 요구합니다. | 자동 검증 완료 |
| H-06 / F-11 접근성 금액 불일치 | 시각 결과와 접근성 output이 같은 계산 상태를 사용하고 silent tick announce를 억제합니다. 실제 NVDA·VoiceOver·TalkBack 음성 결과는 실기기 gate입니다. | 코드 완료·외부 검증 필요 |
| H-07 / F-06 개인정보·철회 | 공유 전 항목·목적·최대 보관·공개 범위·철회 권한을 고지하고, pending→공유→finalize와 취소/실패 revoke, 개인정보 안내 페이지를 추가했습니다. 법률 적합성 판단은 전문 검토가 필요합니다. | 코드 완료·외부 결정 필요 |

## Medium / P2

| 항목 | 조치 | 상태 |
| --- | --- | --- |
| M-01 / F-07 Lightning 남용 | fail-closed 전용 limiter, 정확한 media type, 엄격한 주소·callback 관계, 공개 HTTPS 제한, bounded body, 0/1/2 redirect와 초과·429·timeout 경계시험을 추가했습니다. discovery와 callback 전체를 하나의 12초 deadline으로 묶고 LUD-06 metadata 및 LUD-18 필수 payer data를 callback 전에 검증하며, 응답 BOLT11의 메인넷·정확한 금액·만료·서명도 Worker에서 확인합니다. 보고서의 “요청당 최대 두 외부 호출” 표현은 부정확했고, redirect를 포함하면 더 많은 hop이 가능했습니다. | 자동 검증 완료 |
| M-02 / F-08 시세 신선도 | 20초 WebSocket watchdog, stale 전환, socket 종료, REST fallback, 공유 차단·복구를 구현했습니다. | 자동 검증 완료 |
| M-03 / F-09 타입 검사 | 앱·Worker runtime 독립 typecheck를 고치고 릴리스 gate에 포함했습니다. | 자동 검증 완료 |
| M-04 / F-10 공급망 감사 | 취약 의존성을 갱신하고 전체 graph의 high-severity audit를 CI gate로 사용합니다. | 자동 검증 완료 |
| M-05 입력 상한 | UI·서버를 999.99%, 최대 15자리 금액 계약으로 통일하고 10억 원 이상 거래 확인을 추가했습니다. | 자동 검증 완료 |
| M-06 / F-12 label 구조 | premium label, textbox, 44×44 stepper group을 분리하고 axe를 실행합니다. | 자동 검증 완료 |
| M-07 / F-13 320px overflow | nowrap 의존을 제거하고 320px 수평 overflow와 44×44 target을 브라우저에서 검사합니다. | 자동 검증 완료 |
| M-08 / F-15 offline verify | 전용 verify/404 shell을 필수 precache하고 API cache와 root 오용 fallback을 금지하며 실제 offline 404를 검증합니다. | 자동 검증 완료 |
| M-09 / F-14 PWA inset | 불필요한 window-controls overlay를 제거하고 safe-area를 반영했습니다. 실제 설치·노치 화면은 실기기 gate입니다. | 코드 완료·외부 검증 필요 |
| M-10 / F-16 테스트 전략 | Node, Workers Vitest, Playwright, axe, 가짜 시간, PWA offline, 실제 rate-limit binding, 배포 smoke를 하나의 gate로 묶었습니다. | 자동 검증 완료 |
| M-11 / F-17 관측성 | Cloudflare가 custom log event에도 request URL metadata를 붙일 수 있으므로 production·preview의 account observability, custom/invocation log persistence와 trace persistence를 모두 fail-closed로 껐습니다. template화한 route class와 고정 오류명만 내보내는 console 코드는 유지합니다. 실제 비수집 확인과 URL metadata를 제거하는 외부 pipeline, synthetic·5xx·latency·quota 경보 및 test alert는 계정에서 구성해야 합니다. | 코드 완료·외부 운영 미완료 |
| M-12 / F-18 복구·일관성 | signed absolute expiry를 조회·복원 후에도 강제하고, 신규 lifecycle 상태를 record별 SQLite Durable Object에서 직렬화했습니다. 기존 KV는 lazy migration과 순서 보장형 비동기 호환 mirror로만 사용합니다. RPO/RTO, absolute expiration, revoke/deletion 전파, quarantine restore 절차의 실제 운영은 별도 완료해야 합니다. | 코드 자동 검증 완료; 외부 복구 운영 필요 |
| M-13 / F-19 키 수명 | public-key 선배포, signer 전환, 구 key 180일+ 유지와 compromise 절차를 문서화했습니다. private-key 보관 방식과 승인형 rotation 실행은 운영 보안 결정이 필요합니다. | 외부 결정·운영 필요 |
| M-14 신뢰 UX | 생성 전과 검증 결과에서 서명이 신원·입금·수령·완료를 증명하지 않는다는 점을 고정 노출합니다. | 자동 검증 완료 |
| M-15 / F-20 module-global I/O | 요청별 Promise와 context를 공유하지 않고 Cache API만 재사용하도록 바꾸고 동시성 계약을 검사합니다. | 자동 검증 완료 |
| M-16 취소·고아 기록 | 15분 pending, 동일 capability 멱등 재시도, 공유 후 finalize, 실패·취소·조건 변경 revoke를 구현했습니다. 헤더 없는 구버전 요청과 직접 finalized 생성도 저장 전에 거부합니다. | 자동 검증 완료 |
| M-17 orientation | manifest의 portrait 고정을 제거했습니다. 설치 앱 회전은 실기기 gate입니다. | 코드 완료·외부 검증 필요 |
| M-18 결제 우선 IA | 검증 화면에서 조건과 서명 한계를 결제 QR보다 먼저 배치했습니다. | 자동 검증 완료 |
| M-19 transient activation | “준비”와 별도 사용자 클릭 “공유”의 2단계로 분리했습니다. 실제 native share 성공 판정은 iOS/Android gate입니다. 원래 항목은 실기기 재현 전 개연성 판단이었습니다. | 코드 완료·외부 검증 필요; 원래 주장은 조건부 |
| M-20 quota | 70/90% 경보와 용량 점검 절차를 문서화했습니다. 실제 요금제·사용량은 저장소에서 알 수 없으며 Free plan 결함이 확인된 것은 아닙니다. | 외부 운영 필요; 원래 주장은 조건부 |
| M-21 Actions 공급망 | 모든 action을 전체 commit SHA로 고정하고 Dependabot, SBOM, notices, checksum, provenance attestation을 추가했습니다. | 자동 검증 완료 |
| M-22 배포 경쟁 | production concurrency와 최신 `main` SHA guard를 추가했습니다. staging도 최신 `staging` SHA, 직렬 실행, 후보 version ID smoke, 정확한 version 승격을 요구합니다. 자동 rollback은 저장소·binding·key 호환성을 판단하지 못한 채 상태를 악화시킬 수 있어 강제하지 않고, 승인형 rollback 절차로 유지합니다. | 자동 검증 완료; canary/rollback 실행은 외부 운영 필요 |
| M-23 Lightning 주소 정규화 | client와 Worker가 동일한 ASCII·domain·port·private-name 정규화 함수를 사용합니다. | 자동 검증 완료 |
| M-24 market 응답 크기 | 고정 upstream도 bounded reader와 schema-before-use를 사용합니다. | 자동 검증 완료 |
| M-25 capability 로그 | console payload에서 record ID·bearer pathname을 제외하고 route class만 남기며, Cloudflare-enriched URL metadata가 저장되지 않도록 account persistence도 끕니다. 검증된 외부 export allowlist와 보존 권한 구성은 외부 운영 gate입니다. | 코드 완료·외부 검증 필요 |

## Low / P3

| 항목 | 조치 | 상태 |
| --- | --- | --- |
| L-01 retention/schema 결합 | v1의 15,552,000초와 canonical 순서를 불변 policy/canonicalizer로 분리하고 신규 schema 절차를 명시했습니다. | 자동 검증 완료 |
| L-02 / F-21 CSP | build 산출물의 script/style hash만 허용하며 `unsafe-inline`을 제거했습니다. 2,000자 `_headers` 한계를 피하기 위해 Worker가 HTML CSP를 적용합니다. | 자동 검증 완료 |
| L-03 / F-23 BOLT11 길이 | DOM `maxLength`와 state slice를 함께 적용했습니다. | 자동 검증 완료 |
| L-04 / F-24 API 404 | 모든 알 수 없는 `/api/*`를 no-store JSON 404와 공통 보안 헤더로 반환합니다. | 자동 검증 완료 |
| L-05 / F-22 metadata | root/install OG·Twitter image와 설명을 통일했습니다. | 자동 검증 완료 |
| L-06 검색/PWA 설명 | sitemap, robots, 최신 manifest 설명을 추가했습니다. | 자동 검증 완료 |
| L-07 / F-25 대형 파일 | 계산·freshness·timeout·payment lifecycle·공유 lifecycle·market upstream 정책을 별도 모듈과 단위시험으로 분리했습니다. 파일 길이 자체보다 상태 전이와 순수 정책의 독립 시험을 합격 기준으로 사용합니다. | 자동 검증 완료 |
| L-08 / F-26 릴리스 추적 | v2.3.0 후보, changelog, `/api/version`, Worker SHA tag/message, release record 절차를 추가했습니다. 실제 배포 성공 뒤에만 annotated `v2.3.0` tag를 만들 수 있습니다. | 코드 완료·외부 배포 필요 |
| L-09 라이선스 | lock 기준 runtime notices, SBOM·inventory·checksum과 artifact 검사 gate를 추가했습니다. 프로젝트 고유 코드의 배포 라이선스와 법률 승인은 권리자가 결정해야 하며, 결정 전 외부 배포는 중단합니다. | 외부 결정 필요 |
| L-10 lockfile drift | manifest와 lock root를 표준 npm 절차로 맞추고 clean `npm ci`, build, audit를 gate로 검증합니다. | 자동 검증 완료 |

## 세 번째 공유 보고서의 추가 항목

- QR의 금액 포함 여부와 BIP21 복사 대상을 명시하고 주소-only와 금액 포함 요청을 분리했습니다.
- 1~1,000 sat 극소액의 Lightning/온체인 dust·수수료 경고를 추가하되 1 sat 자체를 잘못 금지하지 않았습니다.
- 역할·금액 변경 시 결제정보를 stale로 만들고 공유를 막으며, 결제정보가 유효한 동안 금액과 기준 시세를 고정합니다.
- 자금 출처를 local draft에 저장하지 않고, 12시간 만료·수동 삭제·다중 탭 동기화를 추가했습니다.
- 서비스 워커 update를 사용자에게 알리고 명시적 승인 전 `skipWaiting`하지 않습니다.
- 알 수 없는 offline URL은 계산기 shell이 아니라 실제 404를 반환합니다.
- 44×44 조절 버튼, 고액 확인, 시장 요청 timeout, fallback 복구, 브라우저 상태 머신 시험을 추가했습니다.
- DNS rebinding 우려는 URL의 IP literal·local/private 이름, HTTPS/443, redirect와 callback 관계를 매 단계 제한했습니다. DNS resolution 이후의 네트워크 egress 정책은 Cloudflare 플랫폼 정책과 계정 보안 설정도 함께 확인해야 합니다.

## 완료 전 독립 재감사에서 추가로 확인한 항목

- Cloudflare의 production Worker preview alias는 별도 환경이 아니며 production secret을 상속할 수 있음을 실측했습니다. canonical staging을 별도 Worker로 분리하고 기존 alias를 staging으로 간주하지 않습니다.
- Cloudflare branch build가 HTML만 성공시키고 참조 JS·CSS를 모두 404로 만든 사례를 재현했습니다. smoke가 네 개 HTML 경로의 전체 동일 출처 asset graph와 정확한 Worker version ID를 검사하도록 확장했습니다.
- 거래 기록 기능 플래그가 누락된 환경에서 활성화될 수 있던 fail-open을 제거하고, 정확히 production이면서 `TRADE_RECORDS_ENABLED=true`인 경우만 활성화합니다.
- KV eventual consistency로 finalize·revoke·read가 역전될 수 있던 lifecycle을 record별 SQLite Durable Object로 옮겼습니다. create·조회·finalize·revoke 제한은 DO 선택 전에 실행해 고카디널리티 객체 활성화도 제한합니다.
- 거래 기록 GET과 JSON body stream에 전체 deadline이 없던 문제를 수정하고 hanging fetch·slow stream 회귀시험을 추가했습니다.
- 클라이언트가 제출한 업비트 프리미엄 참고값은 서버가 데이터랩 원본과 0.5%p 범위로 독립 검증한 뒤에만 서명합니다.
- staging/preview 배너, 동적 version alias의 서비스 워커 제거, modulepreload 검사, 지연 로딩 QR과 44px 관리 버튼을 재검증했습니다.

## 프로덕션 승인 전 외부 완료 조건

코드 branch의 완료와 프로덕션 운영 준비 완료는 같지 않습니다. 다음 항목은 [프로덕션 운영 런북](./production-operations.md)과 [실기기 체크리스트](./release-device-checklist.md)에 증적이 남기 전까지 미완료입니다.

1. Cloudflare Git 직접 배포 연결 해제와 production/staging/preview binding 실측
2. GitHub `main` 보호, 필수 verify, production reviewer와 최소권한 environment secret
3. account custom/invocation log·trace persistence 비활성화 실측, Cloudflare-enriched URL metadata를 제거하는 외부 pipeline, synthetic·5xx·latency·quota 경보의 실제 test alert
4. 암호화 backup 목적지·service identity·삭제 ledger 구성과 quarantine restore 훈련
5. 승인형 signer rotation 절차와 비밀키 보관·침해 훈련
6. iPhone Safari, Android Chrome, Windows 설치·회전·offline·native share 시험 및 NVDA·VoiceOver·TalkBack 시험
7. 프로젝트 권리·라이선스, 개인정보·규제 범위와 사용자 고지에 대한 전문 검토
8. 동일 산출물 배포와 읽기 전용 smoke가 성공한 뒤의 annotated tag·release record
