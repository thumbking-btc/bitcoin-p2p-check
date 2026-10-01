# 맥락 복원에 따른 후속 개선

2026-09-29. 현재 프로젝트의 구현과 [대화·구현 대조 감사](conversation-implementation-audit-2026-09-29.md)를 출발점으로, 사용자가 요구한 실제 개선을 수행한다. 기존 기능을 다시 만든 항목과 빠진 동선을 구분한다.

## 판매자 원본에서 구매자가 이어받기

8월 24일 「거래 시퀀스 설계」의 직접 사용자 요청은 판매자가 조건을 공유하면 구매자가 링크를 열어 자신의 받을 정보를 넣고 다시 공유하는 것이다. 구 링크에는 있었지만 서명 기록 전환 때 연결이 빠졌다. 현재 원본 확인 화면에 **구매자로 이어서 입력**을 추가했다.

- 서명 검증을 통과하고 제공 기한이 남은 판매자 기록에서만 보인다. 잘못된 서명·구매자 기록·만료 기록에는 나오지 않는다. 화면을 열어둔 채 기한이 지나도 사라진다.
- 선택한 입력 금액, 판매자 프리미엄, BTC/sats 표시 단위를 가져온다. 원화 기준이면 원화 입력을, BTC 기준이면 수량을 유지하고 반대 금액은 현재 시세로 다시 계산한다. 진입 버튼 옆과 계산기에서 이 점을 알린다.
- 구매 역할·거래 기록 카드 모드를 열고 수취정보는 비워둔다. 사용자는 계산 금액을 확인하고 자신의 온체인/라이트닝 받을 정보를 넣어 기존 준비·공유 흐름을 사용한다.
- 판매자 주소·인보이스·자금 출처·서명·원본 ID·철회 권한을 링크에 복사하지 않는다. 새 링크는 계산 입력만 담으며, 새 카드에는 별도의 기록과 권한이 생긴다. 원본 기록은 수정하지 않는다.
- 기존 v1/v2/v3 링크의 동작은 유지한다. 이 동선에 사용하는 표시자는 판매자 v3 링크에서만 허용하며 추가 숨은 데이터나 자금 출처를 거부한다.

양쪽 금액을 고정한 채 주소만 덧붙이는 공동 거래확정 기능으로 확장하지 않았다. 사용자 원문에는 시세 고정 정책을 지정한 발언이 없으며, 과거 구현의 선택 금액 유지·현재 시세 재계산 방식과 현재 서명 원본의 불변성을 결합했다. 상대방 가입이나 공동 승인 절차도 추가하지 않았다.

## 지갑에서 복사한 대문자 주소 호환성

과거 별도 후보의 차이를 현재 코드와 [BIP173](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki#bech32), [BIP350](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki#test-vectors-for-v0-v16-native-segregated-witness-addresses)에 대조했다. 전체 대문자 SegWit v0/v1은 유효한 표기인데 기존 입력 경로가 모두 거부했다.

`createOnchainRequest`에서 전체 대문자인 `BC1…`만 소문자로 바꾼 뒤 기존 주소·체크섬·네트워크·witness 검증을 수행한다. 일반 주소와 BIP21 입력이 같은 경로를 사용한다. 혼합 대소문자는 정규화하지 않고 계속 거부하며 Base58의 대소문자도 그대로 둔다.

새 서명 요청은 정규화된 주소를 저장할 수 있지만 payload는 그 주소 또는 정확한 금액 URI와 일치해야 한다. 이미 서명된 기록의 주소·payload를 바꿔도 검증이 통과하도록 만드는 변경은 없다. strict 주소 decoder와 기존 서명 바이트 생성은 유지했다.

## 추가 자료 확인

앞선 감사에서 남겨둔 Vault 원본 이미지 44개를 직접 열어보았다. 팀 전체 열람은 관련 **69/69개 고유 파일**이며 71개 참조의 중복을 제외한 수치다. 추가 제품 화면 두 개는 당시 푸터 여백 수정 요구와 초기 화면이고, 현재 방향을 바꾸는 신규 요구는 없었다. 나머지는 설정·설치 화면이다. 후기 0% 기본 프리미엄·14일 기록 등으로 대체된 초기 표시를 되살리지 않는다.

이 수치는 모든 서비스의 모든 메시지·모든 worktree 결과물을 읽었다는 뜻이 아니다. 보관본 밖 대화, 누락된 과거 임시 첨부 파일, 도구 출력 전체 등에 관한 감사 문서의 제한은 유지한다. 열람 파일과 원문 위치는 Git 제외 조사 산출물 `outputs/research/coverage-vault-20260929-images-additional.json`과 통합 inventory에 보존한다.

## 의존성 보안 패치

첫 전체 검증에서 기능 검사는 통과했지만 마지막 npm 감사가 high 1개·moderate 5개로 실패했다. 이를 성공 실행으로 기록하지 않는다. 9월 28일 GitHub Advisory DB에 반영된 `fast-uri`와 `undici` 공지를 대조하고 `fast-uri` 3.1.6→3.1.8, `undici` 7.29.0→7.29.1 보안 패치를 적용했다. [fast-uri 보안 릴리스](https://github.com/fastify/fast-uri/releases/tag/v3.1.8), [undici 보안 릴리스](https://github.com/nodejs/undici/releases/tag/v7.29.1).

직접 Cloudflare·React·Node 도구 버전은 바꾸지 않았다. 현재 Miniflare가 이전 undici를 정확히 고정하고 있어 `miniflare@5.20260921.0-alpha`에만 패치 override를 적용했다. 향후 Miniflare 갱신 시 상위 패키지의 수정 반영을 확인해 이 override를 검토한다. 감사 기준을 낮추거나 강제 주요 버전 변경으로 해결하지 않았다. 수정 후 별도 audit 결과는 모든 등급 0건이며 전체 기능 검증도 다시 실행한다.

## 검증

- 새 동선 6개: 320px 판매자 원본→구매자 입력→실제 PNG 저장→새 원본 검증, KRW/BTC 두 입력 기준, 열린 페이지의 기한 만료, 잘못된 서명·구매자·만료 기록의 진입 차단.
- 실제 새 PNG는 1440×1080이며 QR 해독값은 구매자의 입력 주소와 일치했다. 모바일 화면 3장과 카드 1장을 직접 열어 겹침·잘림을 확인했다.
- 추가 주소 시험: v0/v1 전체 대문자 일반 주소·BIP21 입력의 정규화와 mixed-case 차단. 서명 후 case 변경은 서명 검증에 실패한다.
- 1차 전체 검증: Node 277/277, Worker 16+4+4, 브라우저 43/43, lint·두 typecheck·notice·build·타입 drift·세 환경 dry-run 통과. 마지막 dependency audit 실패는 위에서 보존했다.
- 패치 적용 후 재검증은 Node 277개·Worker 24개를 통과했지만 브라우저 42/43에서 기존 교차 탭 시험이 실패했다. trace에서 숨겨진 라디오에 대한 강제 클릭이 공유 영역을 닫은 것을 확인했다. 보이는 label을 정상 클릭하도록 고치고 원래 저장소 검증은 유지했다. 재시도 없는 집중 시험 3/3이 통과했다(`revoke-record-focused-20260929.log`). 실패 로그는 `outputs/validation/continuation-verify-ci-patched-20260929.log`, 후속 검사 결과는 같은 validation 폴더의 final 로그에 보존한다.
- 최종 commit의 GitHub Actions `Verify`가 전체 gate를 다시 수행하고 성공한 동일 산출물만 staging에 배포한다. 최초 실행과 재실행을 한 번에 성공한 것으로 바꾸어 보고하지 않는다.

로컬 새 동선 시험은 임시 P-256 테스트 키로 실제 서명·검증을 수행한다. API와 시세는 결정적인 테스트 값이며 원격 거래 기록을 만들지 않는다. 따라서 실제 staging 배포·Durable Object·기기 공유시트·지갑 동작을 모두 검증했다고 표현하지 않는다. 배포 후 별도 원격 검증을 수행한다.

화면 증거는 `outputs/validation/continuation-20260929/`의 `seller-verification-mobile.png`, `buyer-prefilled-mobile.png`, `buyer-record-card.png`, `buyer-verification-mobile.png`와 `review.md`다.

## 배포 경계

배포 전 공개 staging 기준선은 `488286e`다. 9월 23일 직접 사용자 원문 `msg_01a0cc9c-233d-7631-b59d-738988b41ace` §10은 모든 검증이 끝난 최종 Astra 후보를 기존 격리 staging에 배포하라고 지시하며 §12는 이를 완료 조건으로 지정한다. 현재 작업은 그 후보에서 회수한 미충족 요구를 이어 완성하는 후속 작업이다. 따라서 이 검수 갱신을 진행하되 후보 채택·운영 전환 승인으로 확대하지 않는다.

후보 commit을 보존하고 staging을 fast-forward한 뒤 기존 `Verify` workflow에서 staging 배포만 선택한다. 정확한 CI 산출물·version·전체 SHA·secret allowlist·단일 100% 트래픽·CSP·캐시·synthetic 기록 수명주기를 확인한다. 배포 영수증과 main·production 불변 확인은 Git 제외 `outputs/validation/continuation-deployment-receipt-20260929.json`에 별도로 기록한다. 이 문서에 자기 commit SHA를 넣는 순환을 피한다.

Vault 원본·main·production을 수정하지 않으며 실기기 검수와 production 전환의 미완료 경계는 [프로젝트 상태](../PROJECT_STATUS.md)에 유지한다.

## 2026-10-01 재개

9월 29일 작업은 로컬 구현·검증 산출물을 남겼으나 commit·검수 배포 전에 실행이 중단되었다. 10월 1일 실제 서버를 다시 확인해 여전히 `488286e`임을 확인했다. 마지막 교차 탭 시험 3/3과 보안 감사 0건 결과를 회수했으며 최종 commit에서 전체 검증·검수 게시를 이어서 수행한다. 기존 화면 이미지는 9월 29일 로컬 결과물이다.

10월 1일 최종 소스 검증에서 Node 277/277·Worker 24/24·브라우저 43/43과 나머지 정적/설정 검사는 통과했지만 마지막 audit는 새 brace-expansion 공지로 실패했다. 검사 도구의 하위 패키지만 1.1.18→1.1.21, 5.0.9→5.0.12로 올렸고 부모 패키지·앱 실행 코드는 유지했다. 수정 후 audit 모든 등급 0건이다. 마지막 전체 CI는 이 패치를 포함하는 최종 commit으로 수행한다. [공식 보안 공지](https://github.com/advisories/GHSA-qhr7-859c-m2p7).


## 2026-10-01 staging 배포 전 CI에서 발견한 접근성 문제

사용자가 기존 main/staging 중 staging 갱신을 명시적으로 승인한 뒤 `ae4e750`으로 실행한 GitHub Actions 36873008649는 브라우저 42/43에서 멈췄으며 배포 단계는 실행되지 않았다. Linux 브라우저에서 긴 모집글 미리보기의 스크롤 영역에 키보드 초점이 없어 axe `scrollable-region-focusable` 검사가 실패했다. 앱의 스크롤 미리보기에 이름 있는 region·tabIndex 0·눈에 보이는 focus outline을 추가했다. [W3C 키보드 접근 기준](https://www.w3.org/WAI/standards-guidelines/act/rules/0ssw9k)에 맞춰 기존 시험을 긴 텍스트·Shift+Tab 진입·End 스크롤 검사로 강화했다. 접근성 규칙이나 CI 실패 기준은 그대로 유지한다.

같은 CI 로그에서 자동 입력이 focus 시 천 단위 구분자 제거와 겹쳐 이전 숫자 뒤에 붙은 것도 확인했다. 시험에서 먼저 focus 후 원래 입력값이 나타나는 것을 확인한 다음 fill하며, 입력 결과도 정확히 2500000인지 검증한다. 처음 추가한 키보드 시험은 DOM 순서에 맞지 않아 실패했고, 미리보기 바로 다음 공유 버튼에서 Shift+Tab으로 이동하도록 수정했다. 실패 로그도 validation 폴더에 보존한다. 수정 후 집중 검사·최종 소스의 전체 검사와 staging 실제 동선 결과는 별도 배포 영수증에 기록한다.
