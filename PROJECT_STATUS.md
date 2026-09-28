# 현재 프로젝트 상태

갱신: 2026-09-29 KST. 다음 작업의 출발점이며 정식 출시 승인 기록이 아닙니다.

## 목적과 유지할 결정

구매자·판매자가 익숙한 한 화면에서 원화·BTC·sats와 판매자 프리미엄을 계산하고, 짧은 공개 모집글로 상대를 찾은 뒤 DM에서 합의한 조건과 선택 수취정보를 4:3 카드로 전달하는 PWA입니다. 상대방의 가입이나 공동 입력 없이 사용할 수 있어야 합니다.

- 판매자 프리미엄 기본값 0%, 구매자가 표시된 BTC를 받고 전송 수수료는 판매자가 부담합니다.
- 공개 모집글에는 결제 주소·인보이스·QR·실제 자금 출처를 자동 포함하지 않습니다. 결제정보는 합의 후 거래 기록 카드에서 선택합니다.
- 유효한 수취정보 입력은 로컬 검증 후 카드에 포함합니다. Lightning Address의 원격 인보이스 발급은 명시적으로 요청해야 합니다.
- 짧은 모집글, 직접 편집, 우측 QR이 있는 4:3 카드, 복사 가능한 수취정보를 유지합니다.
- 업비트 가격은 WebSocket, 프리미엄·온체인 수수료 참고값은 5분 주기입니다. 오래되거나 신뢰할 수 없는 시세·변경된 조건·만료 임박 인보이스는 공유를 막습니다.
- 새 기록은 비공개 준비 15분, 공유·저장 성공 후 공개 14일입니다. 작성자는 링크를 철회할 수 있습니다. 서명은 보관된 조건의 무결성을 확인하며 실제 입금이나 거래 완료를 확인하지 않습니다.
- 자동 초안 저장은 유지하고 상시 초안 삭제 UI와 불필요한 안내는 되살리지 않습니다. 공개 기록 관리 등 부가기능은 접힌 상태를 유지합니다.
- 현재 운영 PWA를 갑자기 바꾸지 말라는 직접 요구가 있습니다. 후보의 구현·자동 검증·검수 배포는 최종 채택이나 production 배포 승인과 다릅니다.

근거는 [사용자 원문 근거](docs/astra-user-evidence-2026-09-23.md), [후보 검토·구현 기록](docs/astra-review-2026-09-23.md), [기존 통합 결정](docs/candidate-v2.3.1-decision-record.md)입니다. 이번에도 Obsidian의 관련 사용자 원문과 9월 5~6일 Codex 후속 발언을 대조했습니다. Vault export는 9월 4일까지이므로 이후 상태는 Git·구현·배포 증거로 보완합니다. 별도 지갑·Lightning Split의 기능을 이 프로젝트의 미완료 요구로 합치지 않습니다.

## 현재 기준선

| 항목 | 확인 상태 |
| --- | --- |
| 이번 작업 시작 폴더 | `fix/full-feature-review-20260905@b808871` — 9월 6일 상태 |
| 이어받은 최신 구현 | `candidate/p2p-v3-astra-review@488286e772322d5d81f0dae41a4b53549d3e07b6` — 9월 23일 후보 |
| 현재 로컬 작업 브랜치 | `work/p2p-v1-completion-20260929` — 위 후보에서 계속 작업 |
| 9월 29일 실제 staging API | 앱 `2.3.1`, Worker `b1f83622-c8ec-45d5-9afd-13ef46304e01`, tag `488286e772322d5d81f0dae41a4b53549d3e07b6` |
| 검수 주소 | https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev/?pwa-review=1 |
| 기존 산출물 | 시작 전부터 미추적이던 `docs/p2p-research-2026-09-05/`는 그대로 보존 |

최신 후보는 시작 폴더의 후속 커밋이며 이미 메모 입력 포커스, 오래된 시세 모집글 차단, 수취정보 자동 포함, 공유 자원 대기 제한, PWA commit별 캐시와 설치 요청 중복 문제를 수정했습니다. 이전 브랜치·후보·main을 덮어쓰지 않고 현재 작업 폴더에서 최신 후보를 이어받았습니다.

9월 5일 조사 문서의 현재 보존 기간 180일·참고값 60초, 9월 22일 문서의 후보 미배포 표시는 당시 스냅샷입니다. 이를 최신 의도나 배포 상태로 복원하지 않습니다. 기존 v1 기록의 180일 서명 검증 호환성은 유지합니다.

## V1 완료 조건과 검증

| 사용자 흐름 | 확인할 결과 |
| --- | --- |
| 구매/판매 × 원/sats/BTC × 프리미엄 | 원화·BTC 방향과 정확한 금액 계산이 일치 |
| 모집글 편집·복사·공유 | 연속 입력의 포커스 유지, 직접 편집 보존, 사적 결제정보 자동 포함 없음 |
| 주소/BIP21/Lightning Address/BOLT11 | 유효한 입력 포함, 부분·금액 불일치·잘못된 네트워크·만료 입력 차단 |
| 카드 준비 → 공유/저장 → 원본 확인 | 준비 기록 비공개, 전달 성공 뒤 확정, 4:3 PNG·QR·서명 조건 일치 |
| 취소·실패·철회 | 불필요한 공개 기록을 남기지 않고 철회한 링크 조회 차단 |
| PWA 업데이트·오프라인 | 새 소스의 앱 셸 적용, API·개별 기록 URL 미캐시, 오래된 시세 공유 차단 |

9월 23일 기준선의 전체 검증 및 실제 staging 흐름은 기존 검토 기록에 있습니다. 자동 브라우저 검증을 실제 휴대전화 지갑·공유시트 시험으로 바꾸어 표현하지 않습니다.

## 9월 29일 수행 결과

- 최신 후보를 이 작업 폴더로 이어받고, 시세 관측 시각이 기기 시계보다 미래일 때도 공유 가능하던 문제를 수정했습니다. `isReferenceShareable`은 이제 시세 나이가 0 이상·5분 미만일 때만 통과합니다. 수정 전 실패하는 회귀시험을 먼저 확인했고 코드 수정은 `9c35363`에 보존했습니다.
- 거래 기록의 교차 탭 철회 시험이 화면 준비 전에 강제 클릭하여 실패하는 경합을 보완했습니다. 초기 진입·새로고침에서 실제 계산기 준비를 기다린 뒤 기존 저장소 검증을 수행합니다. 해당 시험 3회 반복과 이후 전체 브라우저 시험이 통과했습니다.
- Git에서 제외하는 로컬 조사·검증 산출물 `outputs/`, `work/`가 앱 lint 대상에 섞이지 않도록 ESLint 제외 범위를 맞췄습니다. 앱·Worker·정식 scripts/tests 검사는 유지합니다.
- README의 복사 기능 위치·문구와 후보 배포 상태 설명을 현재 구현에 맞췄습니다.

| 검사 | 결과·증거 |
| --- | --- |
| 최신 후보 기준선 `npm ci`, `npm run verify:ci` | 통과. `outputs/validation/verify-ci-20260929.log` |
| 수정 앱 lint·application/Worker typecheck·notice·build | 통과. `outputs/validation/verify-ci-final-20260929.log` |
| 수정 앱 Node 테스트 | 263/263 통과 |
| production/staging/preview 로컬 Worker 테스트 | 16/16 + 4/4 + 4/4 통과 |
| 교차 탭 시험 수정 후 전체 Playwright | 36/36 통과. `outputs/validation/verify-resume-20260929.log` |
| Worker type drift·세 환경 dry-run·dependency audit | 모두 통과, 취약점 0건. 같은 resume 로그 |
| 실제 staging 정적 파일·CSP·캐시·배포 ID | 읽기 전용 smoke 통과. `outputs/validation/staging-smoke-20260929.log` |
| 실제 staging 시세 → 모집글 | 실시간 조건 수신 후 모집글 공유 버튼 활성 확인. 전송 동작은 실행하지 않음. `outputs/validation/staging-live-market-20260929.json` |
| 실제 Chromium/WebKit 화면·PWA | 최초 11/12 통과, WebKit PWA 탐색 1건 30초 timeout. 격리 PWA 재검사 2/2 통과; 최초 지연 원인은 미확정. `outputs/validation/staging-browser-20260929.log`, `outputs/research/webkit-pwa-diagnostic-20260929-{1,2}.json` |

수정 앱의 첫 전체 실행은 브라우저 시험 35/36에서 멈췄으므로 그 명령을 성공으로 기록하지 않습니다. 이후 시험 준비 경합을 수정하고 lint·typecheck·전체 브라우저 시험과 남은 type/config/audit gate를 재실행해 통과했습니다. 현재 `dist`는 앱 코드 `9c35363` 기준이며, 승인된 배포 때에는 최종 커밋에서 다시 검증된 정확한 산출물을 사용해야 합니다.

이번 원격 요청은 읽기 전용입니다. 새 거래 기록·송금·원격 push·검수 서버 갱신·운영 배포·tag 변경을 하지 않았습니다. 현재 공개 staging은 계속 `488286e`이며 이번 시계 역행 수정은 로컬에만 있습니다.

## 남은 출시 경계

1. 실제 Samsung Internet·Android Chrome·iPhone Safari에서 설치·외부 앱 공유·지갑 QR 금액을 확인해야 합니다. [실기기 체크리스트](docs/release-device-checklist.md)를 사용합니다. 실제 자금 송금은 필요하지 않습니다.
2. production 활성 version의 46개 코드 module을 공식 exact-version API로 복원했습니다. [원본 확인 기록](docs/production-baseline-2026-09-29.md)에 식별자·digest·복원 방법을 남겼습니다. 원래 Git SHA와 전체 정적 asset의 대응은 아직 미확인이므로 `origin/main`과 같다고 단정할 수 없습니다. Worker 이름으로 최신 script를 내려받는 API는 활성 version과 다른 코드를 반환했습니다.
3. 기존 production의 KV/API/정적 파일 동작을 보존하는 별도 Durable Object export bootstrap과, 검증된 산출물을 사용하는 승인형 원자 배포 경로가 필요합니다. 후보의 `allowLegacyKv` 옵션은 구버전 요청·서명 계약을 그대로 보존하는 bootstrap이 아닙니다.
4. 사용자 후보 채택과 운영 변경 승인 이후에만 main 반영·production 배포·정식 release를 수행합니다. [운영 런북](docs/production-operations.md)의 현재 차단을 직접 배포로 우회하지 않습니다.

다음 작업은 전체 제품 재설계나 오래된 브랜치 재조사가 아니라, 이 기준선에서 확인된 결함 수정과 위 출시 경계 해소입니다.
