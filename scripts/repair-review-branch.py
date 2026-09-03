from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
EXPECTED_HEAD_REF = "review/ux-safety-20260903"
EXPECTED_BASE_REF = "staging"
EXPECTED_COMMIT_MESSAGE = "ci: fix guarded repair gate restore"
NORMAL_GATE = '''name: Staging PR Gate

on:
  pull_request:
    branches: [staging]

permissions:
  contents: read

concurrency:
  group: staging-pr-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  verify-preview:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 35
    steps:
      - name: Check out the exact PR revision
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.0.0
        with:
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Use Node.js 22.19.0
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version: 22.19.0
          cache: npm

      - name: Install locked dependencies
        run: npm ci

      - name: Install the verified browser runtime
        run: npx playwright install --with-deps chromium

      - name: Run the complete release gate
        run: npm run verify:ci

      - name: Verify the built static asset graph
        run: node scripts/check-static-assets.mjs

      - name: Verify the matching Cloudflare branch preview
        run: node scripts/check-branch-preview.mjs
        env:
          PREVIEW_BASE_URL: https://staging-bitcoin-p2p-check.thumbking-btc.workers.dev
          PREVIEW_WAIT_MS: "300000"
'''


def fail(message: str) -> None:
    raise SystemExit(message)


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    target = REPO / path
    text = target.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != expected:
        fail(f"{path}: expected {expected} occurrence(s), found {actual}: {old!r}")
    target.write_text(text.replace(old, new), encoding="utf-8")


def git_text(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


def main() -> None:
    if os.environ.get("GITHUB_HEAD_REF") != EXPECTED_HEAD_REF:
        fail("Refusing repair outside the exact review branch.")
    if os.environ.get("GITHUB_BASE_REF") != EXPECTED_BASE_REF:
        fail("Refusing repair outside the staging pull request.")
    if git_text("log", "-1", "--format=%s") != EXPECTED_COMMIT_MESSAGE:
        fail("Unexpected repair commit; refusing to mutate the checkout.")

    replace_exact(
        "app/lib/market-refresh.mjs",
        "export const MARKET_REFRESH_WITH_LIVE_PRICE_MS = 5 * 60_000;",
        "export const MARKET_REFRESH_WITH_LIVE_PRICE_MS = 60_000;",
    )
    replace_exact(
        "app/components/P2PTradeTool.tsx",
        "약 5분마다 자동 갱신 ·",
        "약 1분마다 자동 갱신 ·",
        2,
    )
    replace_exact(
        "tests/rendered-html.test.mjs",
        "assert.equal(MARKET_REFRESH_WITH_LIVE_PRICE_MS, 5 * 60_000);",
        "assert.equal(MARKET_REFRESH_WITH_LIVE_PRICE_MS, 60_000);",
    )
    replace_exact(
        "tests/rendered-html.test.mjs",
        "assert.equal(getMarketRefreshDelay(100_000, MARKET_REFRESH_WITH_LIVE_PRICE_MS, 399_999), 1);",
        "assert.equal(getMarketRefreshDelay(100_000, MARKET_REFRESH_WITH_LIVE_PRICE_MS, 159_999), 1);",
    )
    replace_exact(
        "tests/rendered-html.test.mjs",
        "assert.equal(getMarketRefreshDelay(100_000, MARKET_REFRESH_WITH_LIVE_PRICE_MS, 400_000), 0);",
        "assert.equal(getMarketRefreshDelay(100_000, MARKET_REFRESH_WITH_LIVE_PRICE_MS, 160_000), 0);",
    )
    replace_exact(
        "tests/rendered-html.test.mjs",
        "assert.match(component, /약 5분마다 자동 갱신 ·/);",
        "assert.match(component, /약 1분마다 자동 갱신 ·/);",
    )
    replace_exact(
        "e2e/hardening.spec.ts",
        "/유효하지 않은 거래 기록 관리 권한을 브라우저 저장소에서 제거했습니다/u",
        "/유효하지 않은 거래 기록 관리 권한을 브라우저에서 제거했습니다/u",
    )
    replace_exact(
        "e2e/hardening.spec.ts",
        'await expect(page.getByText("카드에 포함됨", { exact: true })).toBeVisible();',
        'await expect(page.getByText("결제정보 미포함", { exact: true })).toHaveCount(0);',
    )
    replace_exact(
        "e2e/hardening.spec.ts",
        'await expect(page.getByText("곧 만료 · 포함 중지", { exact: true })).toBeVisible();',
        'await expect(page.getByText("곧 만료 · 사용 중지", { exact: true })).toBeVisible();',
    )
    replace_exact(
        "e2e/hardening.spec.ts",
        'await expect(page.getByText("만료 · 포함 중지", { exact: true })).toBeVisible();',
        'await expect(page.getByText("만료 · 사용 중지", { exact: true })).toBeVisible();',
    )
    replace_exact(
        "e2e/hardening.spec.ts",
        '''  await expect(page.getByText("실시간 시세 수신이 중단되었습니다. 최신 시세를 다시 확인하고 있습니다.", { exact: true })).toBeVisible();
  await expect(shareButton).toBeDisabled();

  market.releaseFallback();
  await expect(page.getByText("실시간 시세 수신이 중단되었습니다. 최신 시세를 다시 확인하고 있습니다.", { exact: true })).toHaveCount(0);''',
        '''  const recoveryStatus = page.getByRole("button", { name: "업비트 시세와 온체인 수수료율 조회 중" });
  await expect(recoveryStatus).toBeVisible();
  await expect(shareButton).toBeDisabled();

  market.releaseFallback();
  await expect(recoveryStatus).toHaveCount(0);''',
    )

    (REPO / ".github/workflows/staging-pr-gate.yml").write_text(NORMAL_GATE, encoding="utf-8")
    Path(__file__).unlink()
    subprocess.run(["git", "diff", "--check"], cwd=REPO, check=True)
    print("Guarded review repair candidate prepared successfully.")


if __name__ == "__main__":
    main()
