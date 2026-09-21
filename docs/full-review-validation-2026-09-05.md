# 전체 기능 검수 결과 — 2026-09-05

## 배포 식별

- 검수 주소: https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev/?pwa-review=1
- 앱 소스 commit: `86af70850edde59bd8f8cea6e6a0c2f3a0ba305c`
- 앱 후보 버전: `2.3.0`
- Worker version: `9970bc64-c1ff-41a9-8593-efc31587f0dc`, 100% 단일 배포
- Worker tag: 위 앱 소스 commit과 일치
- 별도 staging 저장소와 기존 staging signer를 사용했습니다. 배포 전후 secret 이름 allowlist를 확인했으며 키를 재발급하지 않았습니다.
- 운영 Worker의 배포 목록이 전후 동일함을 확인했습니다. 운영 활성 version은 `44ac3cbb-ef30-43a1-aebb-b32bb029c605`로 유지되었습니다.

사용자의 전체 기능 검수 수정 요청에 따라 기존 staging Worker를 로컬 Wrangler OAuth로 갱신했습니다. GitHub staging environment에 배포 secrets가 없으므로 CI 실행이나 최초 bootstrap으로 가장하지 않았습니다. 기존 CI·production guard는 변경하지 않았습니다. 원격 account/subdomain과 배포 기준 상태, 정확한 staging 구성, commit된 소스, 검증된 bundle 및 CSP를 확인한 뒤 staging 구성만 지정해 배포했습니다. 원격 응답과 검증 로그는 로컬 `.git/p2p-*.log`에 보관했습니다. 이는 자동 배포 경로의 상시 변경이 아닙니다.

## 검증

| 검사 | 결과 |
|---|---|
| Node 22.19.0 `npm run verify:ci` | 통과 |
| 기본·보안·빌드 결과 검사 | 256개 통과 |
| Worker runtime 검사 | production 16개, staging 4개, preview 4개 통과 |
| 로컬 브라우저 E2E | 26개 통과 |
| 타입·lint·공지·3개 환경 dry-run | 통과 |
| npm audit | 알려진 취약점 0개 |
| 실제 배포 정적 자산·CSP·버전 고정 smoke | 통과 |
| 실제 staging API lifecycle | 생성 → 비공개 조회 차단 → 확정 → 서명 검증 → 철회 → 조회 차단 통과 |
| 실제 staging Chromium UI lifecycle | 카드 준비 → PNG 저장 → 공개 확정 → 서명 확인 화면 → 공개 링크 비활성화 통과 |
| Chromium·WebKit 반응형 | 각 320·390·1280px, 가로 넘침·스타일 누락·스크립트/CSP 오류 없음 |
| 부가 페이지와 JavaScript 비활성 상태 | 두 엔진 모두 통과 |
| PWA | Chromium 설치 동의·오프라인 재실행·복귀·해제, WebKit 설치 동의·온라인 재실행·해제 통과 |

브라우저 검사는 `scripts/check-preview-browser.mjs`, 실제 공유 검사는 `scripts/check-staging-share-browser.mjs`로 재현할 수 있습니다. 후자는 시험용 기록을 만들므로 `STAGING_STATEFUL_TEST_APPROVED=true`를 요구하고 주소는 canonical staging으로 고정합니다. 생성한 시험용 공개 기록은 정리 후 404를 확인했습니다.

화면 캡처와 다운로드 PNG는 로컬 `preview-browser-evidence/`에 보관했습니다. 기존 문구를 그대로 기대하던 검사와 새 검수 스크립트의 접힌 관리 영역 선택자를 수정한 뒤 해당 검사를 재실행해 통과했습니다. 이 검수 스크립트 수정은 배포 앱 코드를 바꾸지 않습니다.

## 해석 범위

- 기존 immutable preview URL은 과거 배포를 계속 가리킵니다. 전체 기능 검수에는 위 주소를 사용하십시오.
- 실제 BTC·원화 송금, 외부 지갑의 메모 표시, 실제 iPhone 홈 화면 앱의 오프라인 실행을 검증했다고 주장하지 않습니다.
- 앱은 발급 응답과 기록 무결성을 검증합니다. 실제 입금 완료를 자동으로 판정하지 않습니다.
- 사용자의 법적 책임 유무를 이번 문구 개선으로 확정하지 않습니다. 반복되는 면책 표현보다 공개 범위와 실제 확인 동작을 명확하게 전달하는 데 집중했습니다.
