# Astra 후보 검토 — 2026-09-23

상태: 조사·검증 중인 미승인 후보입니다. 기존 후보의 구현·배포는 사용자 승인을 뜻하지 않습니다.

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

최종 조사 범위·추가 근거·변경·테스트·배포 증거는 검증 후 이 문서에 기록합니다. 원문과 개인 첨부 자체는 코드 저장소에 복제하지 않습니다.
