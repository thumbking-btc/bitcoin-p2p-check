import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("puts amount-bound payment actions before address-only fallbacks", async () => {
  const receiveInfo = await source("../app/components/TradeReceiveInfoPortal.tsx");

  const onchainPrimary = receiveInfo.indexOf(">금액 포함 QR 만들기</button>");
  const onchainFallback = receiveInfo.indexOf(">주소만 포함</button>", onchainPrimary);
  assert.ok(onchainPrimary >= 0, "amount-bound onchain action must exist");
  assert.ok(onchainFallback > onchainPrimary, "address-only onchain action must follow the amount-bound action");

  const lightningPrimary = receiveInfo.indexOf(">{buildLabel}</button>", onchainFallback);
  const lightningFallback = receiveInfo.indexOf(">주소만 포함</button>", lightningPrimary);
  assert.ok(lightningPrimary > onchainFallback, "lightning invoice action must exist");
  assert.ok(lightningFallback > lightningPrimary, "address-only lightning action must follow the invoice action");
});

test("describes prepared payment state without implying it was already shared", async () => {
  const receiveInfo = await source("../app/components/TradeReceiveInfoPortal.tsx");

  assert.match(receiveInfo, /결제정보 지우기/);
  assert.match(receiveInfo, /새 시세로 다시 계산하려면 결제정보를 지우십시오/);
  assert.match(receiveInfo, /lifecycleState\.status === "ready" \? "사용 가능"/);
  assert.doesNotMatch(receiveInfo, /카드에 포함됨/);
});

test("preserves the current amount basis when switching buy and sell roles", async () => {
  const calculator = await source("../app/components/P2PTradeTool.tsx");
  const start = calculator.indexOf("function changeTradeRole(nextRole: TradeRole)");
  const end = calculator.indexOf("function clearSavedDraft()", start);
  const roleSwitch = calculator.slice(start, end);

  assert.ok(start >= 0 && end > start, "role switch handler must exist");
  assert.match(roleSwitch, /if \(amountBasis === "krw"\)/);
  assert.match(roleSwitch, /setKrwAmounts\(\(current\) => \(\{ \.\.\.current, \[nextRole\]: nextKrw \}\)\)/);
  assert.match(roleSwitch, /setAmountBasisByRole\(\(current\) => \(\{ \.\.\.current, \[nextRole\]: "krw" \}\)\)/);
  assert.match(roleSwitch, /setBitcoinAmountInputs\(\(current\) => \(\{ \.\.\.current, \[nextRole\]: nextBitcoin \}\)\)/);
  assert.match(roleSwitch, /setAmountBasisByRole\(\(current\) => \(\{ \.\.\.current, \[nextRole\]: "bitcoin" \}\)\)/);
  assert.match(roleSwitch, /setTradeRole\(nextRole\)/);
});

test("shows verified trade conditions before payment details", async () => {
  const verifier = await source("../app/verify/TradeRecordVerifier.tsx");
  const condition = verifier.lastIndexOf("<RecordDetails record={state.result.record} />");
  const payment = verifier.lastIndexOf("<PaymentDetails record={state.result.record} paymentExpiry={paymentExpiry} />");

  assert.ok(condition >= 0 && payment > condition, "trade conditions must render before payment details");
  assert.match(verifier, /서명은 기록 무결성만 확인합니다/);
});

test("keeps generic safety copy out of the global footer", async () => {
  const home = await source("../app/page.tsx");

  assert.doesNotMatch(home, /입금 내역과 온체인 전송 상태를 각각 확인하세요/);
  assert.match(home, /<SiteRouteNav current="calculator" \/>/);
});
