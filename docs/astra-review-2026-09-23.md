# Astra 후보 검토 — 2026-09-23

상태: 조사·구현·전체 검증을 마친 미승인 채택 후보입니다. 기존 후보와 Astra 후보의 구현·배포는 사용자 승인을 뜻하지 않습니다. 배포 결과의 정확한 HEAD/version/deployment는 로컬 배포 영수증과 최종 전달 보고서에 기록합니다.

## 기준과 안전 범위

- 출발점: `candidate/p2p-v3-mainline@75c2529ea815b611acde793c9421e8d62d94b057`.
- 작업 브랜치: `candidate/p2p-v3-astra-review`, 별도 linked worktree.
- 실제 origin/main: `ca735db062f1c7fd6eceab3f6a86c01b20fada45`. 로컬 main은 `7c50fedf0809bbd057751155072428ddc72648b9`로 뒤처져 있으며 변경하지 않습니다.
- origin/staging과 원래 작업 폴더: `b808871e4177d9998f2eb1e1f957d75a6b006546`. 미추적 `docs/p2p-research-2026-09-05/`는 보존합니다.
- 실제 staging: version `6f4a290a-23a0-495c-8034-a70eeb324878`, deployment `6a597d7e-4804-4b7a-9543-0795c4290a95`, 100%, tag는 출발점 전체 SHA. 기존 판단 문서의 미배포 표시는 낡았습니다.
- 바로 이전 복구 기준: 위 version과 `75c2529`. 더 이전 보존 기준: `b808871` / `8c0d2953-3415-45e4-87ee-80001200183b` / deployment `cfb8bbfc-96e7-49e4-bc6c-42c384b42668`.
- 실제 production: version `44ac3cbb-ef30-43a1-aebb-b32bb029c605`, deployment `9ec7e49a-017e-40ec-b92b-42ef7f9c26e0`, 100%. 이 version에는 source SHA tag가 없고 `/api/version`은 404이므로 원격 main과 배포 코드의 정확한 일치를 단정하지 않습니다.
- main, 기존 후보, production, tags, 기존 데이터는 수정하지 않습니다. 검증용 synthetic lifecycle만 staging에서 허용합니다.

## 구현 전 요구사항 분류

| 분류 | 판단 | 근거 |
|---|---|---|
| 반드시 유지 | 단일 화면, 구매/판매의 원화·BTC 방향, 원/sats/BTC, 기본 0%, 참고값 5분, stale 공유 차단 | 현재 사용자 지시, 실제 코드와 main 이력 |
| 반드시 유지 | 짧은 모집글·직접 편집, 공개 모집과 합의 후 결제 분리 | 사용자 `09ff1465-651a-4c5d-8b15-868c626b7e04`: 실제 Discord 예시와 staging 과잉 지적 |
| 반드시 유지 | 익숙한 디자인을 보존하는 4:3 카드, 조건과 QR 한 장 | `203b5450-b325-461f-a613-16e6b1d4fbd6`, 긍정 `2c74a08d-95ee-44d2-bf80-e7cab9a297b5`, 급격한 변경 우려 `2d3f1f16-81e8-41e6-bac1-177ad66f8b51` |
| 개선 가치 높음 | 연속 메모 입력/우대 설정에서 포커스 유지, stale 모집글 차단 | baseline 실제 Chrome에서 입력 후 details 닫힘·body focus 재현, 카드와 모집글 freshness 정책 불일치 |
| 개선 가치 높음 | 로고·clipboard 대기에 제한, 실패 시 검증된 폴백, 같은 앱 버전 PWA 갱신 | 공유 시점 생성 및 인앱 사용성 요구, 실제 코드의 무기한 Promise·캐시 identity 확인 |
| 신중한 유지 | 서명된 기록, pending→공유→finalize, 14일 공개 및 철회 | 현재 코드·Git 이력으로 존재 확인. 사용자 승인된 UI라고 간주하지 않으며 후보에서 검증 |
| 제외 | 모집 단계에 지급 QR, 자동 거래 완료 판정, 초기 카드 렌더, PSBT, 전면 UI 재작성 | 직접 요구의 근거 부족 또는 공개 모집 분리와 충돌 |
| 제외 | 1분 참고값 갱신·항상 보이는 draft 관리 재도입 | `b808871`의 후속 단순화와 현재 사용자 지시 |

완료 취소선은 Discord 게시물을 거래 후 수정한 사례이며 자동 체결 확인 기능의 요구로 해석하지 않습니다. `a618b985-308c-4e0e-aef4-1f2cd9bc4d8f`는 main 미반영과 기존 PWA 사용자 혼란 방지를 직접 요구합니다. 브랜치 전략 대화의 Cloudflare 기능 질문은 자동배포 승인으로 해석하지 않습니다.

## 조사 방법과 한계

Vault는 clean main `5e9109edf276c96834b961cce27179a007946e58`입니다. 루트 AGENTS/README, 세 서비스 reader와 `Knowledge/resuming-work.md`를 읽고 검색→카드→원문→동일 message ID와 후속 분기→첨부 순서로 확장합니다. ChatGPT export는 2026-09-04, Claude/Gemini export는 2026-09-11 기준이며 이후 상태는 Git·현재 배포와 별도로 대조합니다. 과거 사용자 메시지에 붙여 넣은 Assistant 완료 보고도 직접 관찰·채택 발언과 구분합니다.

상세 원문 분류는 [사용자 근거 조사](astra-user-evidence-2026-09-23.md)에 기록했습니다. 원문과 개인 첨부 자체는 코드 저장소에 복제하지 않습니다.

## 원문 대조 후 수정한 판단

- 14일 보존을 단순히 기존 구현으로만 유지하려던 판단은 후속 원문 회수로 강화되었습니다. 9월 5일 `msg_01a071a3-7987-7ab0-b742-15e1b2d539a7`의 2주 제안과 9월 6일 `msg_01a0728c-6802-7131-913d-be3e103c9e94`의 반영·프리뷰 요청이 직접 근거입니다. 현재 UI의 결과 승인과는 다릅니다.
- `msg_01a0729d-d0d2-7821-92ed-dc7f0e197eed`는 복잡해진 UI·저장된 초안 삭제와 참고값의 1분 갱신을 직접 지적합니다. 자동 초안 보존은 유지하되 상시 관리 UI를 되살리지 않습니다. 당시 Assistant는 프리뷰 배포 실패도 기록했으므로 과거 완료 보고만으로 배포를 인정하지 않습니다.
- QR 로고의 첫 실패를 전면 철회로 해석하지 않았습니다. 후기 `dafcf2a6-e7a9-4ea7-8261-9bec03542a16`은 12% 수정안의 희미한 로고를 수용했습니다. 합성 후 실제 디코딩 성공 조건과 무로고 폴백을 보존합니다.
- `c55f804a-d138-4693-a719-9631de10d7b4`의 주소 입력만으로 카드에 QR을 포함하라는 요구는 기존 후보가 충족하지 못했습니다. 이 근거 때문에 별도 확인 버튼에 의존하던 수취정보 경로를 추가 수정했습니다.

## 발견한 문제와 최종 변경 의도

| 문제 | 이전 동작 | 수정 동작 |
|---|---|---|
| 모집글 메모·우대 조건 DOM 재생성 | 한 글자 입력 후 details 닫힘·포커스 유실. 실제 Chrome와 3폭에서 재현 | DOM을 유지하며 구조화 조건 변경 때 문구만 갱신. 수동 편집은 실시간 시세 tick에 유지 |
| stale 및 잘못된 계산값의 모집글 | 카드만 차단되고 모집글은 공유 가능 | 공유·명시 복사 모두 계산 유효성과 참고시각 재검증 |
| 모바일의 복사 선택 불명확 | 공유 API 지원 환경에서 직접 복사 동작을 고르기 어려움 | 작은 `모집글 복사` 버튼 제공. 사적 수취정보는 모집글에 넣지 않음 |
| 입력한 결제정보 누락 | 주소 입력 후 QR 준비 버튼을 누르지 않으면 결제정보 없는 카드 | mainnet 주소·BIP21·Lightning Address·BOLT11은 입력 시 로컬 검증하여 포함. 부분/잘못된 입력은 공유 차단 |
| 원하지 않은 원격 발급 위험 | 자동 포함 요구를 네트워크 자동 호출로 잘못 확장할 여지 | LNURL/주소의 인보이스 발급은 명시 버튼만 수행. 금액·역할 변경 후 기존 결과는 stale 유지 |
| 선택 자원의 무기한 대기 | 로고·폰트·clipboard 지연이 카드 전달/기록 확정을 막음 | 로고·폰트 1.5초, clipboard 1.2초 제한. 실제 검증된 QR과 다운로드 폴백 유지 |
| 철회 링크 404 설명 | 잠시 후 확인 안내로 영구 철회/만료도 일시 장애처럼 표시 | 철회·만료·미공개 가능성을 정확히 표시 |
| 같은 2.3.1 내 PWA 후보 교체 | SW bytes와 cache key가 같아 과거 앱 셸 잔존 가능 | 빌드한 정확한 commit을 SW script/cache identity에 삽입. 사용자 적용형 업데이트 유지 |
| PWA 설치 자산 중복 | 병렬 앱 셸이 공통 JS/CSS를 캐시에 넣기 전 각각 요청 | install 범위 Promise Map으로 동일 자산의 진행 중 요청도 공유 |
| 환경 표시·PWA 업데이트 알림 접근성 | aside에 허용되지 않는 status 역할 | 동일한 화면·안내 동작의 div로 수정 |
| JavaScript 비활성 | 큰 빈 영역과 조회 중 표시 | 계산·시세에 JavaScript가 필요하다는 안내 제공 |

금액 입력 → 계산 → 짧은 모집글 → DM에서 합의 → 선택한 결제정보와 카드 → 공유/저장 후 공개 → 서명 확인 → 링크 비활성화라는 흐름을 유지합니다. 기록은 실제 체결·입금 증명이 아니며, bearer 링크를 가진 사람이 열람하는 조건 기록입니다. 관리 UI는 접힌 상태를 유지합니다.

## 구조·운영 검토

원격 main→출발 후보는 145개 파일이며 생성 Worker 타입의 비중이 큽니다. origin/staging→출발 후보는 19개 파일로 dependency/toolchain·검증·로고 복원이 중심입니다. `9db94f0`에서 모집글 remount 회귀가 생겼고 `b808871`에서 draft 관리 UI와 1분 참고값이 철회되었습니다. 전체 계산기를 재작성할 근거는 없으므로 확인된 결함에 한정했습니다.

production/staging은 별도 Worker·서명키·rate-limit namespace를 사용하고 preview는 기록 기능을 비활성화합니다. staging에는 SQLite Durable Object export가 있으며 KV를 추가하지 않았습니다. 공유 전 pending은 비공개이고 전달 후 finalize하며, 실패/취소의 철회 및 capability 복구를 유지합니다. 기존 데이터 삭제나 schema 초기화는 수행하지 않습니다.

Service Worker는 API와 bearer 검증 URL을 저장하지 않고 일반 verify/404 shell만 오프라인 제공합니다. runtime cache는 최대 40개입니다. reference 요청 중복 방지·백그라운드 중지·live price 갱신 제한을 유지합니다. 접힌 패널의 소규모 문자열 계산을 줄이기 위해 복잡한 상태 체계를 추가하지 않았습니다. 공유 이미지 렌더는 동적 import로 유지합니다.

## 검증 기록

`8ae60e452e501b1f64810ff31663ab337ca7e64c`에서 `npm run verify:ci` 전체 exit 0입니다. 이후 원격 WebKit PWA 검사 경합과 PWA 업데이트 알림의 ARIA도 아래와 같이 보완했습니다. 최종 재검증 결과는 배포 영수증에 정확한 HEAD와 함께 기록합니다. 실행 환경은 Node 22.23.2 / npm 10.9.8 / pinned Wrangler 4.136.1입니다.

| 검증 | 결과 |
|---|---|
| ESLint / application TS / Worker TS | 모두 통과 |
| third-party notice / production build | 통과, locked runtime notices 8개 |
| Node 계약·단위·통합 | 262/262 |
| production/staging/preview Worker runtime | 16/16, 4/4, 4/4. localhost 모사이며 실제 production 변경 없음 |
| Playwright | 36/36. 입력·freshness·기록복구·결제경계·PWA·접근성 포함 |
| Wrangler types / 세 환경 config dry-run | 통과. 실제 배포와 구분 |
| dependency audit | 취약점 0건 |
| 추가 실제 Chromium 화면 | 1440/393/320px, 가로 넘침 없음, 연속 메모·복사, 구매/판매×원/sats/BTC×프리미엄 18조합 |
| 추가 접근성 | 6 화면의 WCAG 검사 통과. 전체 axe 검사에서 발견한 환경 표시 ARIA 문제도 수정 후 E2E 통과 |
| PNG·QR | 실제 Canvas 1440×1080 PNG 15개. 검증 링크/주소/BIP21/Lightning Address/BOLT11 × 로고 정상/404/무응답. 전체 payload 디코딩 일치 |
| 기존 PWA 업데이트 | legacy→SHA cache, 같은 2.3.1의 SHA cache→다음 SHA cache 모두 실제 적용 UI·old cache 삭제·offline 최신 shell·API/bearer 미캐시 통과 |
| 지연 로딩 | 초기·숨긴 패널의 시세 tick·카드 선택까지 renderer/QR/logo 요청 없음. 실제 공유 준비에서 로드 |

검증 과정에서 실패도 숨기지 않았습니다. 초기 source 계약의 옛 구조 기대값, 신규 fixture 타입, 테스트 자동 입력의 focus 경합을 수정했습니다. 전체 axe에서 드러난 제품 ARIA 결함과 no-JS 빈 공간은 제품을 수정했습니다. 마지막 전체 실행에는 실패·재시도·skip이 없습니다. 로그는 `outputs/validation/verify-ci-complete.log`입니다.

초기 JS/CSS는 측정 빌드에서 raw 703,187 / 개별 gzip 합계 211,912 bytes(약 207 KiB), 공유 시 추가 graph는 raw 65,578 / gzip 24,105 bytes(약 23.5 KiB)였습니다. 최종 안내 요소·문서 commit으로 hash/압축량이 소폭 바뀔 수 있어 비교는 graph와 약값을 기준으로 합니다. 초기 요청은 16개, 검사한 시장 tick/카드 선택의 추가 요청은 0개였습니다. source map·브라우저 wire 압축 전체를 합친 수치는 아닙니다.

직접 dependency 31개의 lock 일치와 사용처를 확인했습니다. 추가 dependency와 lockfile 변경은 없으며, public asset 18개에 byte-identical 중복이 없습니다. 생성용 SVG를 단순 미참조 파일로 삭제하지 않았습니다. Worker staging dry-run은 256.78 KiB / gzip 59.66 KiB로 유지됩니다.

브라우저 재검토에서 no-JS 안내 아래의 불필요한 계산기 빈 영역도 발견하여 숨겼습니다. 4배 CPU slowdown의 제한적 표본에서 초기 DCL 1,231ms, load 1,326ms, long task 4개(54~78ms), 입력→두 번의 animation frame 27.9~77.8ms였습니다. 실제 기기의 INP 측정이나 전 기종 보증이 아닙니다.

PWA install 중복은 실제 dist HTML을 읽는 VM harness에서 61 fetch 호출/33 unique URL로 재현했고, 수정 후 33/33으로 줄었습니다. 실제 브라우저의 전송 병합·캐시와 별개인 호출 수 결과입니다. 자산 fetch 실패 시 install을 거절하고 불완전 cache를 삭제하는 동작도 검사했습니다.

## 비교 자료·추적 및 배포 원칙

스크린샷은 작업트리의 `preview-browser-evidence/`에 보존했습니다.

- `before-{desktop,mobile-393,mobile-320}.png`와 `after-{desktop,mobile-393,mobile-320}.png`
- `before-*-memo-after-typing.png`와 `after-*-memo-edited.png`: 입력 회귀와 수정 비교
- `before-no-js.png` / `after-no-js.png`
- `after-card-{record,address,bip21,lightning-address,bolt11}-{normal,404,stalled}.png`
- `pwa-*`: 기존 설치본 업데이트·오프라인 검증

조사/동작/성능 세부 증거는 `outputs/research/`의 vault findings, code audit, second review, astra visual QA, performance, final measure, PWA upgrade, dependency assets audit입니다. 원문·로컬 경로·synthetic bearer가 포함될 수 있어 자동 공개하지 않습니다.

의미 있는 commit: `bf2d4a7` 기준·분류 → `ec76bb8` 모집글 포커스/freshness → `b820a03` 공유 자원 timeout → `e1fb68f` PWA commit identity → `b057586` 수취정보 자동 포함·입력 차단 → `a0331cf` 원문 대조 문서 → `215a9ba` SW 요청 중복·ARIA → `8ae60e4` Worker 검사 정렬. main merge·release tag·changelog 출시 처리는 하지 않습니다.

사용자의 이번 staging 배포 지시에 따라 격리 staging 이름/config와 로컬 Wrangler OAuth만 사용합니다. CI identity나 bootstrap 승인을 가장하지 않으며 기존 배포 guard를 변경하지 않습니다. 배포 전후 secret allowlist, exact binding/exports/rate limits, 단일 100% deployment, 전체 SHA tag를 확인하고 canonical asset graph/CSP/cache/readonly smoke와 허용된 synthetic lifecycle을 검사합니다. 테스트 기록은 해당 capability로만 철회합니다.

배포 영수증은 `outputs/validation/astra-deployment-receipt.json`, 최종 전달용 배포 보고서는 `outputs/astra-staging-report.md`에 남깁니다. 이 문서 자체의 commit SHA를 문서 안에 다시 넣는 순환을 피하면서 최종 배포 HEAD를 정확히 기록하기 위한 별도 산출물입니다. 즉시 복구할 version은 `6f4a290a-23a0-495c-8034-a70eeb324878`(source `75c2529ea815b611acde793c9421e8d62d94b057`)이며 더 이전 `8c0d2953-3415-45e4-87ee-80001200183b`도 보존합니다.

## 남은 채택 판단

첫 Astra staging `198914f1b824ddbfbd254427e9ff2a2f8cf806ab` / version `abcbdae9-c9cc-4af7-9caa-b8ee9f0da39e` / deployment `7c8f4089-8c08-4cd1-8a41-ad74ac310f95`에서 실제 공유·서명·철회와 PNG 디코딩은 통과했습니다. 원격 Chromium/WebKit 12개 검사 중 WebKit PWA 1개가 일시 실패하여 추가 진단했습니다. controllerchange 후 자동 reload 전 문서의 hydration 완료와 새 문서의 초기 snapshot을 결합한 테스트 경합으로 재현했고, 새 문서는 410ms에 정상 준비되며 JS/CSP 오류는 없었습니다. 검사기가 한 문서의 준비 완료 snapshot을 사용하도록 수정했습니다. 자세한 문서 identity 타임라인은 `outputs/research/remote-webkit-pwa-diagnose.json`입니다. 이 후속 검토에서 업데이트 알림의 같은 ARIA 문제도 수정했으므로 첫 Astra 배포를 최종 후보로 보고하지 않습니다.

실기기 Samsung Internet·Android Chrome·iPhone Safari의 설치 경험, 외부 앱 공유/clipboard, 실제 지갑의 QR 스캔과 금액 채움은 사용자의 기기에서 최종 확인해야 합니다. Chromium/WebKit 검수와 암호학적·QR 검증을 실기기 결제 승인으로 보고하지 않습니다. 실제 송금은 하지 않았습니다. bearer 링크 공유와 브라우저에 보관하는 철회 capability의 특성은 유지되며, 사용자 데이터·기존 DO 상태는 삭제하지 않았습니다. 현재 후보 UI와 거래 기록 기능의 최종 채택은 여전히 사용자 검토 대상입니다.
