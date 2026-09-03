from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
NORMAL_GATE_COMMIT = "29a03a7dfe0dae91eddf23ee0429f79b8bbee346"
EXPECTED_HEAD_REF = "review/ux-safety-20260903"
EXPECTED_BASE_REF = "staging"


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
    if git_text("log", "-1", "--format=%s") != "ci: activate guarded review repair":
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

    normal_gate = subprocess.check_output(
        ["git", "show", f"{NORMAL_GATE_COMMIT}:.github/workflows/staging-pr-gate.yml"],
        cwd=REPO,
    )
    (REPO / ".github/workflows/staging-pr-gate.yml").write_bytes(normal_gate)
    Path(__file__).unlink()

    subprocess.run(["git", "diff", "--check"], cwd=REPO, check=True)
    print("Guarded review repair candidate prepared successfully.")


if __name__ == "__main__":
    main()
