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
  assert.match(component, /resultReady = Boolean\(result && !resultStale && !resultExpiring\)/u);
  assert.match(component, /onResultChangeRef\.current\(verifiedInfo\)/u);
  assert.match(component, /<strong className=\{styles\.resultAmount\}>\{formatSats\(result\.amountSats\)\}<\/strong>/u);
  assert.match(component, /validateBolt11Invoice\(rawInvoice,[\s\S]*expectedSats: BigInt\(amountSats\)/u);
  assert.match(component, /createOnchainRequest\(target\.address, BigInt\(expectedSats\)\)/u);
  assert.match(component, /target\.amountIncluded \? request\.uri : request\.address/u);
  assert.match(component, /kind: "lightning-address"[\s\S]*payload: address[\s\S]*address,/u);
  assert.doesNotMatch(component, /MutationObserver|createPortal|document\.querySelector|\.dataset/u);
});

test("receive info prepares one compact card payment result without a second sharing flow", async () => {
  const [component, css] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(cssUrl, "utf8"),
  ]);

  assert.doesNotMatch(component, /주소만 복사|인보이스만 복사|수취정보 공유|navigator\.share|<canvas/u);
  assert.match(component, /거래 기록 카드에 포함/u);
  assert.match(component, /<summary>결제정보 보기<\/summary>/u);
  assert.match(component, />주소만 포함<\/button>/u);
  assert.match(css, /\.field > label\s*\{[^}]*font-size:\s*13px/su);
  assert.match(css, /\.input,[\s\S]*?font:\s*720 16px\/1\.3/su);
  assert.match(css, /\.modeButton\s*\{[^}]*min-height:\s*44px/su);
  assert.match(css, /\.actions button\s*\{[^}]*min-height:\s*44px/su);
});

test("holds the visible quote while exact-amount payment information is active", async () => {
  const [component, calculator] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(calculatorUrl, "utf8"),
  ]);

  assert.match(component, /이 결제정보를 사용하는 동안 거래 금액을 고정합니다/u);
  assert.match(calculator, /isSharingRef\.current \|\| paymentLockRef\.current/u);
  assert.match(calculator, /paymentLockRef\.current = Boolean\(info\)/u);
  assert.match(calculator, /if \(pendingSnapshot && !paymentLockRef\.current\)/u);
  assert.match(calculator, /verifiedReceiveInfo \? "금액 고정 중"/u);
  assert.match(calculator, /const receiveConditionKey = JSON\.stringify\(\{ tradeRole, sats: quote\?\.sats \?\? null \}\)/u);
});
