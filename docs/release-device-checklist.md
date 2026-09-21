# 실기기 PWA·공유 릴리스 체크리스트

이 체크리스트는 emulator나 desktop responsive mode가 아니라 실제 iPhone, Android 휴대전화 및 Windows PC에서 release candidate를 검증하기 위한 기록 양식입니다.

> 법률 검토 상태: **미완료**입니다. 이 문서는 기술 검증 절차일 뿐 서비스 운영, 거래 중개 여부, 전자금융·가상자산 규제, AML/KYC, 소비자 보호, 표시·광고, 조세, 개인정보·국외 이전·보존, 분쟁 처리 의무에 관한 법률 의견이나 출시 승인이 아닙니다. 대상 관할권의 자격 있는 법률 담당자가 검토하기 전에는 법률 적합성을 주장하지 마십시오.

## 1. 시험 기록

| 항목 | 기록 |
| --- | --- |
| release version |  |
| 전체 Git SHA |  |
| Cloudflare Worker version ID |  |
| 배포 URL |  |
| 시험 시작·종료 시각(UTC) |  |
| 시험자 |  |
| iPhone 모델 / iOS / Safari |  |
| Android 모델 / Android / Chrome |  |
| Windows 기기 / Windows / Edge 또는 Chrome |  |
| 이전 설치본에서 update 시험 여부 |  |
| 새 설치 상태 시험 여부 |  |
| 증적 링크 |  |

화면 녹화나 screenshot에 거래 주소, invoice, record ID, revoke token, 실제 금액 또는 개인 식별정보가 남지 않도록 synthetic 값만 사용하고 공유 전에 redaction 하십시오.

## 2. 공통 선행 조건

- [ ] 시험 SHA가 production 승인 대상 최신 `main` SHA와 같습니다.
- [ ] `node scripts/smoke-deployment.mjs <BASE_URL>`이 성공했습니다.
- [ ] fresh install과 기존 version에서 update하는 경로를 각각 준비했습니다.
- [ ] 온라인, 느린 네트워크, offline 복귀를 시험할 수 있습니다.
- [ ] 공유 대상 앱은 조직이 승인한 test account를 사용하며 실제 거래 상대에게 보내지 않습니다.
- [ ] 주소·invoice가 필요한 시험에는 재사용하지 않을 test vector만 사용합니다.
- [ ] 실패 시 release를 중단하고 재현 단계, device/OS/browser, SHA를 issue에 기록합니다.

## 3. 실제 iPhone / Safari

- [ ] Safari에서 `/`, `/install/`, `/privacy/`, `/verify/`가 올바른 canonical URL로 열립니다.
- [ ] Safari 공유 메뉴의 **홈 화면에 추가**로 설치할 수 있습니다.
- [ ] 홈 화면 icon, 앱 이름과 standalone 창이 올바르며 Safari 주소창 없이 실행됩니다.
- [ ] fresh install 첫 실행과 기존 설치본의 service worker update가 각각 정상입니다.
- [ ] 앱을 background로 보낸 동안 시장 WebSocket/주기 작업이 멈추고, foreground 복귀 시 재연결됩니다.
- [ ] airplane mode 전환 뒤 캐시된 앱 shell과 설치/개인정보 화면의 의도된 offline 동작을 확인했습니다. API 결과를 offline cache에서 재사용하지 않습니다.
- [ ] 원화·BTC·sats 입력 시 의도하지 않은 viewport zoom, 가림 또는 숫자 keyboard 오류가 없습니다.
- [ ] 세로·가로 회전, safe area, 긴 한국어 문구, 200% text 확대에서도 핵심 동작을 사용할 수 있습니다.
- [ ] 거래 모집글의 native share sheet가 열리고, 선택한 test 메신저에 화면의 최종 편집 문구와 정확히 같은 text가 전달됩니다.
- [ ] 거래 기록 카드의 native file share가 PNG를 전달하며 4:3 비율, 금액, 역할, 시각, QR과 원본 확인 정보가 잘리지 않습니다.
- [ ] share 취소·대상 앱 실패 후 UI가 멈추지 않고 재시도 또는 복사 fallback을 사용할 수 있습니다.
- [ ] `주소만 복사`와 `인보이스만 복사`가 표시값 그대로 복사되며 다른 수취정보가 섞이지 않습니다.

## 4. 실제 Android / Chrome

- [ ] Chrome에서 `/`, `/install/`, `/privacy/`, `/verify/`가 올바르게 열립니다.
- [ ] browser의 앱 설치 또는 홈 화면 추가 흐름이 동작하고 manifest 이름·icon이 올바릅니다.
- [ ] 설치 앱이 standalone으로 열리고 fresh install 및 기존 설치본 update를 각각 확인했습니다.
- [ ] online/offline, background/foreground, 화면 잠금·해제 뒤 시장 데이터 상태와 공유 차단 문구가 정확합니다.
- [ ] 원화·BTC·sats keyboard, back button, app switch, 세로·가로 회전에서 입력이나 draft가 예기치 않게 손실되지 않습니다.
- [ ] 모집글 native share가 test 메신저로 정확한 text만 전달하며 주소·invoice·자금 출처 상세가 포함되지 않습니다.
- [ ] 거래 기록 native file share가 PNG를 실제 file로 전달하고 수신 앱에서 열 수 있습니다.
- [ ] target 앱이 file share를 거부하거나 사용자가 취소해도 복사·재시도 경로가 동작합니다.
- [ ] QR을 다른 실제 기기로 읽었을 때 고정 금액과 수취정보가 화면 표시와 일치합니다.
- [ ] 앱 제거 후 재설치에서 오래된 service worker/cache 때문에 이전 release가 나타나지 않습니다.

## 5. 실제 Windows PWA

시험 browser를 release 지원 대상으로 선택하여 Edge 또는 Chrome 버전을 기록하십시오. Web Share/file share 지원 여부는 browser와 Windows 구성에 따라 다를 수 있으므로, 지원되는 환경의 native flow와 지원되지 않는 환경의 fallback을 둘 다 기록하십시오.

- [ ] browser install UI로 PWA를 설치하고 Start menu/작업 표시줄의 이름·icon을 확인했습니다.
- [ ] 독립 창, 창 크기 변경, 최대화, 200% display scaling에서 레이아웃과 keyboard focus가 정상입니다.
- [ ] Tab/Shift+Tab, Enter, Space, Esc만으로 계산·install 안내·share/fallback control을 사용할 수 있습니다.
- [ ] fresh install, 기존 설치본 update, offline 시작과 online 복귀를 확인했습니다.
- [ ] native Windows share UI가 제공되는 환경에서는 모집글 text와 거래 기록 PNG file을 실제 target 앱으로 전달했습니다.
- [ ] native share를 제공하지 않거나 file share를 거절하는 환경에서는 복사/download 등 제품에 구현된 fallback이 명확하고 작동합니다.
- [ ] clipboard에 복사된 값이 화면 표시와 정확히 같고 이전 clipboard 값이 잘못 재사용되지 않습니다.
- [ ] Windows notification, camera, geolocation, payment 같은 불필요한 권한을 요청하지 않습니다.

## 6. 공유 내용과 거래 기록 검증

모든 지원 기기에서 다음 항목을 실제 수신 결과로 비교하십시오.

- [ ] 모집글에는 구매/판매 역할, 원화·sats/BTC 금액, premium, rail, 사용자가 선택한 공개 문구와 메모만 포함됩니다.
- [ ] 모집글에는 비트코인 주소, BIP21, Lightning Address, BOLT11, QR, 실제 자금 출처 종류, 지급 요청 또는 revoke token이 포함되지 않습니다.
- [ ] 편집한 모집글은 미리보기와 수신 앱의 text가 공백·줄바꿈까지 같습니다.
- [ ] 거래 조건을 바꾼 뒤 오래된 미리보기나 PNG가 재사용되지 않습니다.
- [ ] stale/unavailable 시장값과 만료 임박 invoice에서 공유가 차단됩니다.
- [ ] 거래 기록 PNG의 조건·결제정보와 `/verify/?id=...`의 서명 검증 결과가 같습니다.
- [ ] 원본 확인 링크를 새 browser profile과 다른 실제 기기에서 열어 valid, expired, revoked, not-found 상태를 구분했습니다.
- [ ] signature가 합의·신원·원화 입금·BTC 송수신·거래 완료를 증명하지 않는다는 문구가 사용자에게 보입니다.
- [ ] share 취소·실패 시 만들어진 임시 record의 finalize/revoke lifecycle이 제품 의도와 일치하며 방치된 민감 record가 남지 않습니다.

일상 deployment smoke는 거래 기록을 생성하지 않습니다. 이 section의 stateful 시험은 release candidate 검증 창에서 synthetic 수취정보로만 수행하고, 생성한 record ID와 revoke capability는 공개 증적에 남기지 말며 시험 종료 즉시 revoke하십시오.

## 7. 접근성·개인정보·안전 문구

- [ ] screen reader에서 label, 결과 변경, 오류와 share 상태를 이해할 수 있습니다.
- [ ] 색상만으로 역할·오류·시장 freshness를 구분하지 않습니다.
- [ ] touch target, focus indicator, contrast와 reduced motion을 실제 기기 설정으로 확인했습니다.
- [ ] `/privacy/`의 수집·전송·신규 기록 14일 보관·원본 링크 공개 범위·revoke/삭제 설명이 실제 동작과 일치합니다.
- [ ] service worker가 API 응답이나 거래 기록을 browser cache에 저장하지 않습니다.
- [ ] 외부 Upbit, mempool.space, LNURL-pay 요청에 거래 메모·자금 출처·불필요한 수취정보가 전송되지 않습니다.
- [ ] 서비스 비중개, 상호 신원 확인, 사기 주의, signature의 제한과 보관 기간이 핵심 흐름에서 확인됩니다.

## 8. 법률 검토 gate

다음 항목은 자격 있는 법률·privacy 담당자가 관할권별로 완료해야 합니다. 미완료 상태를 기술 시험 통과로 덮지 마십시오.

- [ ] 서비스가 규제상 중개, 권유, 전자금융 또는 가상자산사업에 해당하는지 검토했습니다.
- [ ] AML/KYC, 제재, suspicious transaction, 미성년자 및 지역 제한 의무를 검토했습니다.
- [ ] 소비자 보호, 표시·광고, 수수료·premium 표시, 오해 방지와 분쟁 처리 절차를 검토했습니다.
- [ ] 개인정보 처리 근거, 최소 수집, 신규 기록 14일 보관, 원본 링크 접근, revoke/삭제, backup 삭제 전파와 국외 이전을 검토했습니다.
- [ ] Lightning Address/LNURL-pay와 외부 API provider에 대한 약관·책임·개인정보 고지를 검토했습니다.
- [ ] 세무·회계 기록 의무와 사용자 고지를 검토했습니다.
- [ ] 이용약관, privacy notice, 면책 문구와 incident/통지 절차를 승인했습니다.
- [ ] 담당자, 검토 일자, 관할권, 승인 문서와 다음 재검토 기한을 기록했습니다.

## 9. Release 판정

| Gate | 담당자 | 결과(PASS/FAIL/BLOCKED) | 증적 | 일시(UTC) |
| --- | --- | --- | --- | --- |
| iPhone PWA + native share |  |  |  |  |
| Android PWA + native share |  |  |  |  |
| Windows PWA + native share/fallback |  |  |  |  |
| 거래 기록·privacy 검증 |  |  |  |  |
| 접근성 |  |  |  |  |
| 법률 검토 |  |  |  |  |
| 최종 release owner |  |  |  |  |

세 기기군 중 하나라도 실제 기기 검증이 없거나 법률 검토가 `BLOCKED`이면, release 기록에 그 사실과 승인된 위험 수용 주체를 명시하십시오. 증적이 없는 항목을 `PASS`로 표시하지 마십시오.
