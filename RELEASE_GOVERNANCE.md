# 릴리스 추적성·라이선스·SBOM 체크리스트

이 문서는 프로덕션에 배포할 코드, Git tag, Cloudflare Worker version, 빌드 산출물과 의존성 증거를 하나의 SHA로 연결하기 위한 필수 게이트입니다. 체크 결과와 산출물은 릴리스별 증거로 보존하십시오.

## 1. 릴리스 준비

- [ ] 릴리스 후보가 승인된 `main`의 최신 커밋이며 작업트리가 깨끗합니다.
- [ ] `package.json`의 버전, 앱 버전 상수, `CHANGELOG.md`의 정식 버전 제목이 일치합니다.
- [x] 현재 변경에는 기존 운영판 `2.2.0`보다 높은 릴리스 후보 `2.3.0`을 부여했습니다. 변경된 코드를 기존 `2.2.0`으로 다시 배포하지 않습니다.
- [ ] Cloudflare의 저장소 직접 자동 배포가 비활성화되어 있고, 승인된 CI 배포 경로만 프로덕션 자격증명을 사용할 수 있습니다.
- [ ] `npm ci`와 전체 릴리스 게이트를 깨끗한 checkout에서 실행했습니다.
- [ ] 프로덕션·프리뷰 바인딩, secret 범위, KV namespace가 서로 격리되었음을 계정 설정에서 확인했습니다.
- [ ] 개인정보 처리, 서비스 약관, 가상자산 관련 규제 범위, 프로젝트 권리와 배포 조건에 필요한 전문 검토가 완료되었습니다. 이 저장소의 문서는 법률 검토를 대체하지 않습니다.

기준 SHA를 먼저 고정하고 이후 단계에서 같은 값을 사용하십시오.

```bash
git fetch --prune --tags origin main
RELEASE_SHA="$(git rev-parse origin/main)"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
RELEASE_VERSION="$(node -p "require('./package.json').version")"
test -n "$RELEASE_SHA" && test -n "$RELEASE_VERSION"
```

## 2. 공급망·서드파티 라이선스

- [ ] 잠금 파일이 manifest와 일치하며 `npm ci`가 잠금 파일을 변경하지 않습니다.
- [ ] 운영 의존성 감사와 dev/build 도구를 포함한 전체 감사가 모두 정책을 통과합니다. 예외가 필요하면 영향 경로, 담당자, 만료일과 보완 통제를 릴리스 기록에 남깁니다.
- [ ] GitHub Actions의 `uses:`가 이동 가능한 tag가 아니라 검토한 전체 커밋 SHA로 고정되어 있습니다.
- [ ] 아래 명령으로 CycloneDX SBOM과 npm 설치 인벤토리를 생성하고, 파일 이름 또는 상위 디렉터리에 버전과 `RELEASE_SHA`를 포함합니다.

```bash
mkdir -p "release-evidence/$RELEASE_VERSION/$RELEASE_SHA"
npm sbom --sbom-format cyclonedx > "release-evidence/$RELEASE_VERSION/$RELEASE_SHA/sbom.cdx.json"
npm query "*" --json > "release-evidence/$RELEASE_VERSION/$RELEASE_SHA/npm-inventory.json"
sha256sum "release-evidence/$RELEASE_VERSION/$RELEASE_SHA/"*.json > "release-evidence/$RELEASE_VERSION/$RELEASE_SHA/SHA256SUMS"
```

- [ ] SBOM과 실제 `dist/client` 및 Worker bundle을 승인된 라이선스 검사 도구로 검사했습니다. `package.json`의 선언만 신뢰하지 말고 패키지에 포함된 `LICENSE`, `NOTICE`, 저작권 파일을 확인합니다.
- [ ] client/Worker에 실제 포함되는 구성요소, build-only 구성요소, optional 구성요소를 구분하고 그 근거를 보존합니다.
- [ ] copyleft, source-offer, attribution, 광고 조항, 특허 조항, 상표·데이터·폰트·이미지 조건을 담당자가 검토했습니다. 자동 검사 결과만으로 법률 적합성을 단정하지 않습니다.
- [x] 잠금된 런타임 의존성 전체의 패키지 내 라이선스·고지를 `npm run notices:generate`로 `THIRD_PARTY_NOTICES.md`에 생성하고 CI에서 잠금 파일과의 일치를 검사합니다.
- [ ] 실제 client/Worker 산출물 검사 결과와 `THIRD_PARTY_NOTICES.md`를 대조하고 법률 검토 승인을 받았습니다.
- [ ] 프로젝트 수준의 배포 조건이 [LICENSE.md](LICENSE.md) 상태와 일치합니다. 명시적 라이선스 또는 승인된 독점 배포 조건이 확정되지 않았다면 외부 배포를 중단합니다.
- [ ] SBOM, 라이선스 검사 결과, `THIRD_PARTY_NOTICES`, 감사 결과, 산출물 checksum을 CI의 변경 불가능한 릴리스 증거로 보존했습니다.

## 3. 정확한 산출물 배포와 SHA 확인

- [ ] 배포 job이 검증 job의 성공에 의존하며, 검증된 `dist/client`와 prebundled Worker artifact를 다시 빌드하지 않고 그대로 사용합니다.
- [ ] 배포 직전 `origin/main`이 `RELEASE_SHA`와 같은지 다시 확인합니다. 더 최신인 `main`이 있으면 오래된 실행을 중단합니다.
- [ ] 프로덕션 동시 배포가 직렬화되어 있으며 승인되지 않은 rollback 경로가 없습니다.
- [ ] Worker 배포 tag와 message에 전체 `RELEASE_SHA`, 앱 버전과 CI 실행 ID가 기록되고, 정적 파일·Worker bundle의 GitHub provenance 및 Worker bundle의 SBOM attestation이 생성되었습니다.
- [ ] 배포 응답의 Worker version ID와 배포 시각을 릴리스 증거에 저장합니다.
- [ ] 배포 후 읽기 전용 smoke가 성공하고 `/api/version`의 `appVersion`과 `workerVersion.tag`가 각각 `RELEASE_VERSION`, `RELEASE_SHA`와 일치합니다.

예시 검증은 다음과 같습니다.

```bash
VERSION_JSON="$(curl --fail --silent --show-error https://bitcoin-p2p-check.thumbking-btc.workers.dev/api/version)"
test "$(printf '%s' "$VERSION_JSON" | jq -r '.appVersion')" = "$RELEASE_VERSION"
test "$(printf '%s' "$VERSION_JSON" | jq -r '.workerVersion.tag')" = "$RELEASE_SHA"
```

불일치하면 tag를 만들지 말고 프로덕션 승격을 실패로 처리하십시오. 코드 rollback 전에 KV schema·binding·키 호환성과 데이터 변경의 비가역성을 별도로 확인하십시오.

## 4. Git annotated tag와 릴리스 증거

모든 검증과 프로덕션 smoke가 성공한 뒤에만 정확한 배포 SHA에 annotated tag를 만드십시오.

```bash
RELEASE_TAG="v$RELEASE_VERSION"
test -z "$(git tag --list "$RELEASE_TAG")"
git tag -a "$RELEASE_TAG" "$RELEASE_SHA" -m "Release $RELEASE_TAG ($RELEASE_SHA)"
test "$(git rev-parse "$RELEASE_TAG^{commit}")" = "$RELEASE_SHA"
test "$(git cat-file -t "$RELEASE_TAG")" = "tag"
git push origin "$RELEASE_TAG"
test "$(git ls-remote origin "refs/tags/$RELEASE_TAG^{}" | cut -f1)" = "$RELEASE_SHA"
```

- [ ] GitHub Release와 changelog가 tag, 전체 SHA, Cloudflare Worker version ID, 배포 시각과 CI 실행 링크를 기록합니다.
- [ ] 릴리스 artifact checksum, SBOM, 라이선스 결과와 고지가 해당 GitHub Release 또는 승인된 장기 보관소에 연결되어 있습니다.
- [ ] 과거에 빠진 `v2.1.x`·`v2.2.0` tag는 당시 실제 배포 SHA를 Cloudflare/GitHub 증거로 확인할 수 있을 때만 복원합니다. 현재 브랜치의 새 코드를 과거 버전 tag에 연결하지 않습니다.
- [ ] 태그와 배포 SHA 대조 결과를 다른 담당자가 교차 확인했습니다.

## 5. 정기 공급망 운영

- [ ] Dependabot의 npm·GitHub Actions 주간 PR을 담당자가 검토합니다. 자동 병합은 릴리스 게이트를 통과한 경우에만 허용합니다.
- [ ] 보안 공지는 주간 일정과 무관하게 즉시 분류하고, 악용 가능성·노출 경로·수정 버전·완화책을 기록합니다.
- [ ] Actions SHA를 갱신할 때 upstream tag의 실제 SHA와 release note를 확인합니다.
- [ ] SBOM과 서드파티 고지는 매 릴리스마다 새로 생성합니다. 이전 결과를 복사해 현재 상태로 간주하지 않습니다.
