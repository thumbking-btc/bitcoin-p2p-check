import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL("../app/components/TradeReceiveInfoPortal.tsx", import.meta.url);
const cssUrl = new URL("../app/components/trade-receive-info.module.css", import.meta.url);
const calculatorUrl = new URL("../app/components/P2PTradeTool.tsx", import.meta.url);

test("receive info exposes only a verified, current, amount-snapshotted result", async () => {
  const component = await readFile(componentUrl, "utf8");

  assert.match(component, /export type VerifiedReceiveInfo[\s\S]*amountSats: number;[\s\S]*payload: string;[\s\S]*copyTarget: string;/u);
  assert.match(component, /expectedSats !== result\.amountSats/u);
  assert.match(component, /conditionKey !== result\.conditionKey/u);
  assert.match(component, /ownerRole !== result\.ownerRole/u);
  assert.match(component, /resultShareable = Boolean\(result && qrReady && !resultStale && !resultExpiring\)/u);
  assert.match(component, /onResultChangeRef\.current\(verifiedInfo\)/u);
  assert.match(component, /<strong className=\{styles\.resultAmount\}>\{formatSats\(result\.amountSats\)\}<\/strong>/u);
  assert.match(component, /validateBolt11Invoice\(result\.payload,[\s\S]*expectedSats: BigInt\(result\.amountSats\)/u);
  assert.match(component, /createOnchainRequest\(result\.copyTarget, BigInt\(result\.amountSats\)\)/u);
  assert.doesNotMatch(component, /MutationObserver|createPortal|document\.querySelector|\.dataset/u);
});

test("receive info offers mobile-safe raw target copying without a wallet-open action", async () => {
  const [component, css] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(cssUrl, "utf8"),
  ]);

  assert.match(component, /주소만 복사/u);
  assert.match(component, /인보이스만 복사/u);
  assert.match(component, />수취정보 공유<\/button>/u);
  assert.doesNotMatch(component, /지갑에서 열기/u);
  assert.match(css, /\.field > label\s*\{[^}]*font-size:\s*13px/su);
  assert.match(css, /\.input,[\s\S]*?font:\s*720 16px\/1\.3/su);
  assert.match(css, /\.modeButton\s*\{[^}]*min-height:\s*44px/su);
  assert.match(css, /\.actions button,[\s\S]*?min-height:\s*44px/su);
});

test("holds the visible quote while an exact-amount payment QR is active", async () => {
  const [component, calculator] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(calculatorUrl, "utf8"),
  ]);

  assert.match(component, /이 QR을 사용하는 동안 거래 금액을 고정합니다/u);
  assert.match(calculator, /isSharingRef\.current \|\| paymentLockRef\.current/u);
  assert.match(calculator, /paymentLockRef\.current = Boolean\(info\)/u);
  assert.match(calculator, /if \(pendingSnapshot && !paymentLockRef\.current\)/u);
  assert.match(calculator, /verifiedReceiveInfo \? "금액 고정 중"/u);
  assert.match(calculator, /const receiveConditionKey = JSON\.stringify\(\{ tradeRole, sats: quote\?\.sats \?\? null \}\)/u);
});
