# P2P 헬퍼 v2.3.1 통합 완성 후보 의사결정 기록

작성일: 2026-09-22

후보 브랜치: `candidate/p2p-v3-mainline`

기준 main: `origin/main@ca735db062f1c7fd6eceab3f6a86c01b20fada45` (`v2.2.3`)

상태: 미배포 후보. main 병합, production 배포, production tag 변경 없음.

## 1. 근거로 조사한 맥락

### 대화와 실제 사용 사례

- ChatGPT 프로젝트 `P2P 헬퍼 사이트 만들기`의 `실거래 모집 방식 기반 P2P 도구 개선`: Discord 모집글이 구매/판매, 원화 금액, 프리미엄, 온체인·라이트닝, 신뢰 조건, DM 요청을 짧게 전달한다는 실제 사례를 기준으로 삼았습니다. 공개 모집글에는 결제 주소·BOLT11·QR이나 실제 자금 출처 상세를 넣지 않고, “자금 출처 설명 가능”처럼 모집에 필요한 의사만 선택적으로 표시합니다.
- `여러 이미지 공유 가능`, `거래 시퀀스 설계`: 긴 가로 카드보다 4:3 비율을 선호했고, 사용자가 4:3 시안을 긍정적으로 평가했습니다. 최초 로고 합성 시안은 스캔 실패했지만, 이후 원본 `creator-logo.jpg`를 QR 한 변의 12%로 합성하고 최종 QR을 다시 디코딩하는 구현은 사용자가 확인 후 긍정했습니다. 후보는 이 후속 결정을 복원하되 합성 검증이 실패하면 무브랜드 QR로 안전하게 되돌립니다.
- `PWA 설치 안내`: Samsung Internet의 설치 경험 문제와 Android Chrome 안내 경로를 확인했습니다. 현재 후보는 Samsung Internet에서 검증된 Chrome 설치 안내로 유도합니다.
- `거래 시퀀스 설계`: 기본 프리미엄이 2%로 남는 이전 draft 문제, 주소 자체 QR, 프리미엄 부호, 과도한 하단 여백, 5분 참고값 갱신에 대한 사용자의 명시적 피드백을 확인했습니다.
- `제품 전방위 감사`, `코드 전반 점검`, 성능 최적화 대화: 공유 이미지를 요청 시점에만 만들기, 시세 WebSocket 감시, REST fallback, Service Worker version cache, 렌더 격리, dependency·bundle 점검 요구를 확인했습니다.
- `P2P v3 브랜치·Cloudflare 배포 전략`: preview alias를 full staging처럼 쓰자는 과거 제안은 현재 Durable Object 제약 및 저장소의 배포 계약과 맞지 않아 채택하지 않았습니다.
- 2026-08-31 Codex 작업 맥락: 당시에는 `integration/p2p-v3`를 staging 기반으로 만드는 선택이 있었지만, 이번 요청의 최신 지시인 “최신 main 기준 새 후보”를 우선했습니다.
- 2026-09-05 Codex 전체 기능 검수 작업: 사용자가 14일 공개 기록 보존을 선택했고, 이후 UI가 복잡해졌다는 피드백으로 항상 보이는 draft 삭제 UI와 1분 참고값 갱신을 철회하고 5분 갱신과 접힌 관리 UI로 단순화한 이력을 확인했습니다.

### Obsidian Knowledge Vault 핵심 감사

- 조사한 Vault는 `knowledge-vault` 저장소의 깨끗한 `main`이며 `HEAD`와 `origin/main`은 모두 `5e9109e`(`docs: focus Obsidian graph on curated knowledge`)였습니다. 루트 `AGENTS.md`, `README.md`, 세 대화 reader 안내와 `Knowledge/resuming-work.md`를 먼저 읽어 자료의 주체·검토 범위·현재 사실을 구분했습니다.
- ChatGPT 로컬 검색 DB에서 사용자 발언을 중심으로 저장소명, 제품명, 모집·공유·QR·PWA·브라우저·캐시·브랜치 표현을 교차 검색해 26개 고유 대화 후보를 얻었습니다. 이어 `knowledge/topics/software.md`, 각 카드의 관계·동일 message ID, `Knowledge/resuming-work.md`의 정정 사례를 따라 범위를 확장하여 관련·경계 확인용 카드 40개를 검토했습니다.
- 핵심 네 대화 `6a871f61-1b98-83ee-9c12-c3d359e0a7c0`, `6a807cc7-43f4-83ee-9658-1c3555c8bc58`, `6a8b1759-1018-83e8-ada6-378bb848c7a0`, `6a8ba690-ec4c-83e8-b938-cd1e72d12fb1`은 의미 요약에 그치지 않고 `reader/conversations/`의 사용자 원문과 첨부까지 역추적했습니다. 실거래 예시는 message `09ff1465-651a-4c5d-8b15-868c626b7e04`, 4:3 선택과 긍정 평가는 `203b5450-b325-461f-a613-16e6b1d4fbd6`·`2c74a08d-95ee-44d2-bf80-e7cab9a297b5`, 최초 QR 스캔 실패는 `eacf326f-89eb-4c2c-a835-2b23a97f1273`, 검증된 12% 로고 구현의 후속 수용은 `f0fb1eb0-a5bb-4817-aa4f-ec6f6e59e40b`에서 확인했습니다.
- 실제 첨부 10개를 열어 기존 16:9 카드, 선호한 4:3 카드, QR 영역·글자 크기·간격 회귀, 계산 기준·제작자 접기 UI를 비교했습니다. 텍스트 요약만으로 긍정·부정 시안을 판정하지 않았습니다.
- Claude 416개 의미 검토와 Gemini 실질 내용 3,123개의 최종 검토층도 같은 용어와 `thumbking-btc`·제품명으로 검색했습니다. Claude 직접 후보 1건은 Corn Wallet 인보이스 구상, Gemini의 넓은 키워드 후보 5건은 일반 P2P·지갑·라이트닝 설명이었고 `bitcoin-p2p-check` 직접 근거는 없었습니다. 이름이 겹친다는 이유로 이 후보의 요구사항에 합치지 않았습니다.
- Vault의 ChatGPT export 기준일은 2026-09-04이므로 이후 2026-09-05 Codex 검수는 Vault에 없다는 한계를 명시했습니다. 후속 판단은 접근 가능한 Codex 맥락, 저장소 문서와 실제 Git commit·코드·테스트를 함께 대조했습니다.

Vault 조사로 계획에서 바뀐 부분은 QR 중앙 제작자 로고의 복원입니다. 이전 후보 기록은 “스캔 실패 시안”만 근거로 로고를 제외했지만 원문에는 그 뒤의 성공한 12% 원본 합성·최종 디코딩 방식과 사용자 수용이 있었습니다. 나머지 후보 구조는 실거래 모집글의 간결성, 공개 모집과 합의 후 결제정보 분리, 4:3 유지, 필요 시 이미지 생성, Samsung Internet 안내, 5분 참고값 정책과 일치하여 유지했습니다.

### 저장소와 Git 근거

- `origin/main@ca735db`: v2.2.3 production mainline. 5분 참고값 갱신, 60초 REST fallback, 15/30/60초 재연결, 중복 데이터 출처 라벨 제거가 반영되어 있습니다.
- `fix/full-feature-review-20260905@b808871`: 2026-09-05 전체 기능 검수 결과. 거래 기록 lifecycle, Lightning 검증, 배포 격리, 14일 관리 capability, 모바일/E2E, 간결한 UI와 5분 갱신 복원이 포함되어 있습니다.
- `9db94f0`, `69115b7`, `29a03a7`, `86af708`, `b808871`: 보안 hardening, main 개선 상속, 결제 안전 문구 간소화, 전체 검수, draft UI 단순화의 주요 근거 commit입니다.
- `docs/ux-safety-review-2026-09-03.md`, `docs/invoice-and-review-2026-09-05.md`, `docs/full-review-validation-2026-09-05.md`, `docs/production-operations.md`: 대화에서 나온 요구가 코드·검증·배포 계약에 실제로 반영되었는지 대조한 문서입니다.

Assistant가 제안만 했고 사용자가 승인하지 않은 아이디어는 요구사항으로 취급하지 않았습니다. 특히 공개 모집글의 결제정보 포함, preview alias의 staging 대체, PSBT·자동 결제 확인은 제외했습니다.

## 2. 요구사항 분류

### 반드시 유지

- 익숙한 단일 화면 계산기와 구매/판매 구분
- 판매자 프리미엄 기본값 0%, +/-/± 의미가 드러나는 표현
- 원화, sats, BTC 기준 입력과 정확한 정수 비율 계산
- 업비트 체결가 기준 계산, 프리미엄·온체인 수수료는 참고값으로 분리
- 5분 참고값 갱신, 실시간 가격 감시, stale 상태에서 공유 차단
- 접혀 있는 공유 도구, 편집 가능한 짧은 모집글
- 4:3 공유 카드와 기존 색·타이포·정보 위계
- 공유 이미지는 사용자가 준비/공유를 눌렀을 때만 생성
- PWA 설치 안내, Samsung Internet에서 Chrome 경로 안내

### 차기 버전에 반영할 가치가 높은 명확한 요구

- 공개 모집글과 합의 후 거래 기록 카드의 명확한 분리
- 온체인 주소, Lightning Address, LNURL-pay, BOLT11의 금액·네트워크·서명·만료 검증
- 현재 거래 금액에 묶인 QR과 주소만 QR의 구분
- 거래 조건과 선택한 결제정보를 담는 서명된 공개 기록
- 공개 링크 14일 만료와 capability 기반 즉시 철회
- 모바일 320px까지 가로 스크롤 없는 레이아웃과 터치 가능한 컨트롤
- preview/staging/production 기능·키·저장소 분리와 production fail-closed gate

### 신중하게 유지한 실험·구조

- Durable Object 기반 pending → finalized → revoked lifecycle은 기능 가치가 높지만 production migration 경계가 있으므로 후보·staging에서만 유지합니다.
- 공개 기록 관리 UI는 항상 노출하지 않고, 생성된 기록이 있을 때 접힌 관리 영역에서만 보이게 합니다.
- 자금 출처는 모집글이 아닌 거래 기록 카드의 선택 항목으로만 남깁니다.
- observability는 request URL에 기록 ID나 결제정보가 포함될 수 있어 검증된 redaction pipeline이 생길 때까지 저장을 끕니다.

### 제외하거나 철회

- 공개 모집글에 주소·인보이스·QR·자금 출처 포함
- 항상 보이는 “저장된 초안 삭제”와 중복 관리 버튼
- 프리미엄·수수료 참고값의 1분 강제 갱신
- 화면 전체를 차지하는 장문의 일반 면책·안전 문구
- 스캔 검증 없이 QR 중앙에 로고를 겹치는 디자인. 검증된 12% 로고는 유지하고, 합성 후 디코딩 실패 시 무브랜드 QR로 되돌립니다.
- production Worker의 version preview URL을 독립 staging으로 간주하는 방식
- PSBT, 지갑 자동 연결, 결제 완료 자동 판정
- 사용자 채택이 확인되지 않은 공통 PWA 수동 업데이트 표준, 공개 모집 단계의 주소·인보이스 자동 첨부, 단계식 협상·승인 UI

## 3. main v2.2.3 대비 후보 변화

- 기존 계산 흐름과 외형을 유지하면서 “상대 찾기·공유하기” 안에서 모집글과 거래 기록 카드를 선택합니다.
- 합의 후에는 판매자가 온체인 주소 또는 Lightning 정보를 검증하고, 조건·결제 QR·검증 링크가 한 카드에 묶입니다.
- 거래 기록은 처음부터 공개되지 않습니다. 비공개 pending 기록을 만든 뒤 이미지가 실제로 준비되어야 finalize되고, 실패한 준비는 공개되지 않습니다.
- 기록별 관리 capability는 브라우저에 분리 저장되며 14일 동안 철회할 수 있습니다. 공개 조회에는 capability가 노출되지 않습니다.
- preview에서는 기록 기능이 명시적으로 꺼지고 full staging 링크를 안내합니다. production과 staging은 서로 다른 signer·namespace 계약을 사용합니다.
- 요청 body·upstream response 크기, redirect, timeout, rate limit, origin·media type, Lightning metadata hash를 제한합니다.
- 4:3 카드 QR에는 1000×1000 제작자 원본을 한 변의 12%로 합성하고 합성된 QR 원문을 재검증합니다. 로고 로드나 재검증이 실패하면 이미 검증된 무브랜드 QR을 사용합니다.
- PWA는 앱 버전별 cache를 사용하고 API 응답과 `/verify/?id=...` bearer URL을 저장하지 않습니다. preview/staging은 기본적으로 Service Worker를 등록하지 않습니다.
- 배포 경로는 GitHub Actions의 승인된 exact artifact만 허용하고, 로컬 production/staging deploy script는 차단합니다.

## 4. 성능·용량 점검

- production Worker dry-run: 256.78 KiB, gzip 59.66 KiB
- preview Worker dry-run: 249.93 KiB, gzip 58.04 KiB
- 정적 client 전체: 51 files, 1,496,340 bytes. 이 수치에는 설치 안내 PNG와 아이콘이 포함됩니다.
- JS 전체: 728,113 bytes, CSS 전체: 70,779 bytes
- 첫 페이지가 참조하는 JS/CSS: raw 700,692 bytes, gzip 213,118 bytes
- 이미지 렌더 구현은 `trade-share-image` 별도 chunk(raw 12,475 bytes)로 분리되어 있고, 공유 준비 시점의 dynamic import 뒤에만 canvas·PNG 작업을 수행합니다. 로고 합성·검증으로 이 지연 chunk만 858 bytes 늘었으며 초기 페이지 참조량은 변하지 않았습니다.
- runtime dependency 7개는 React, QR, Bitcoin/Lightning 주소·서명 검증에 실제 사용됩니다. 불필요한 runtime dependency는 확인되지 않았습니다.
- API는 Service Worker cache에서 제외되고, runtime cache는 버전별 최대 40개로 제한됩니다.
- 직접 의존 중 취약 버전이던 Cloudflare Vite/Vitest plugin, Wrangler, sharp를 호환 가능한 패치·마이너로 올렸고 `npm audit --audit-level=high`는 0건입니다.

대규모 초기 chunk를 더 쪼갤 여지는 있으나, 현재 핵심 상호작용이 한 화면에 강하게 결합되어 있습니다. 수치만 줄이기 위한 추가 분할은 상태·접근성 복잡도를 키우므로 이 후보에서는 하지 않았습니다.

## 5. 검증 결과

- `eslint`: 통과
- application TypeScript 및 Worker runtime typecheck: 통과
- locked runtime third-party notices: 통과
- production build 및 4개 정적 route prerender: 통과
- Node 계약·단위 테스트: 257/257 통과
- Workers runtime: production 16/16, staging 4/4, preview 4/4 통과
- Playwright Chromium E2E: 26/26 통과
- 320px layout, CSP, preview 격리, record lifecycle, Lightning 실패 분류, PWA offline shell을 E2E에서 확인
- generated Worker types: 최신 config와 일치
- production/staging/preview Wrangler dry-run: 모두 통과
- dependency audit: 취약점 0건
- 실제 Chrome: 구매 250만원, 판매자 프리미엄 2%, 온체인 모집글이 계산 결과와 함께 갱신됨을 확인
- 393px 모바일 screenshot: 가로 넘침 없이 구매/판매, 입력, 결과, 수수료, 공유 진입이 표시됨을 확인
- 실제 Chromium에서 1440×1080 공유 PNG를 materialize하여 12% 중앙 로고, 4:3 구성과 QR 배치를 확인했습니다. 같은 입력에서 로고 요청을 404로 강제해도 검증된 무브랜드 QR로 1440×1080 PNG가 생성되는 폴백을 확인했습니다.

로컬 screenshot은 Git에 넣지 않고 `preview-browser-evidence/candidate-desktop.png`, `preview-browser-evidence/candidate-mobile.png`, `preview-browser-evidence/candidate-trade-card-branded.png`에 남겼습니다.

## 6. 채택 전 남은 판단과 위험

- production Durable Object export의 최초 lifecycle bootstrap은 rollback 경계가 있으므로, 현재 production 배포 gate가 의도적으로 막혀 있습니다. 후보 채택과 별도로 운영 승인·bootstrap runbook 검토가 필요합니다.
- 실제 Samsung Internet, Android Chrome 설치, iPhone Safari 홈 화면 추가는 자동화가 완전히 대체할 수 없습니다. `docs/release-device-checklist.md`의 실기기 확인이 남아 있습니다.
- preview는 안전상 거래 기록 생성이 꺼져 있습니다. 전체 기능 비교는 현재 격리된 staging에서 할 수 있지만, 후보 commit 자체를 staging에 배포하지는 않았습니다.
- 초기 JS/CSS gzip 약 213 KiB는 현재 기능 범위에서 허용 가능한 후보 수치로 판단했으나, 저사양 Android에서 체감 성능을 최종 확인하는 것이 좋습니다.
- 공개 기록에 결제정보를 포함하면 14일 동안 URL을 아는 사람이 볼 수 있습니다. UI가 이를 공유 직전에 설명하지만, 실제 운영 채택 전 문구의 이해도를 다시 확인하는 것이 좋습니다.

## 7. 직접 확인할 핵심 시나리오

1. 구매 250만원, 판매자 프리미엄 2%, 온체인으로 모집글을 열고 실제 Discord 문구로 자연스러운지 확인합니다.
2. 판매로 전환하고 sats/BTC 입력 단위를 바꿨을 때 경제적 의미가 유지되는지 확인합니다.
3. 거래 기록 카드에서 유효한 bc1 주소로 금액 포함 QR과 주소만 QR을 각각 확인합니다.
4. Lightning Address와 BOLT11을 각각 입력해 금액 불일치·만료·잘못된 네트워크가 차단되는지 확인합니다.
5. 카드를 준비한 뒤 실제 공유가 성공해야만 공개 링크가 finalize되는지 확인합니다.
6. 공개 링크를 다른 브라우저에서 열고 조건·결제정보·서명을 확인한 뒤 원래 브라우저에서 철회합니다.
7. Android Chrome PWA 설치와 오프라인 앱 셸, Samsung Internet의 Chrome 안내를 실기기에서 확인합니다.

## 8. 비교 방법

- 정확한 후보 화면: 이 worktree에서 `npm ci`, `npm run build`, `npm run start:preview` 후 로컬 URL을 엽니다. preview에서는 거래 기록 기능이 fail closed입니다.
- 전체 기능 검수: `https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev/?pwa-review=1`. 현재 격리 staging은 통합의 기반이 된 `b808871` 기능을 검수하는 환경이며, 이 후보의 보안 dependency update commit 자체는 배포되지 않았습니다.
- main 비교: `git diff ca735db...candidate/p2p-v3-mainline`과 이 문서의 분류를 함께 확인합니다.

후보를 채택하기 전까지 main merge, production 배포, production tag 이동은 금지합니다.
