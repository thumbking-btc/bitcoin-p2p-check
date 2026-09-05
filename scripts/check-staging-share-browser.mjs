import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

// Real, isolated lifecycle test; never accepts an arbitrary or production URL.
assert.equal(process.env.STAGING_STATEFUL_TEST_APPROVED, "true");
const origin = "https://bitcoin-p2p-check-staging.thumbking-btc.workers.dev";
const directory = "preview-browser-evidence";
await mkdir(directory, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, serviceWorkers: "block" });
const page = await context.newPage();
let record;
try {
  await page.goto(origin, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-deployment-environment", "staging");
  await page.getByText("상대 찾기·공유하기", { exact: true }).click();
  await page.getByRole("radio", { name: /거래 기록 카드/u }).check({ force: true });
  const button = page.locator("button.share-button");
  await expect(button).toBeEnabled({ timeout: 30000 });
  const creation = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/trade-record" && response.request().method() === "POST");
  await button.click();
  const response = await creation;
  assert.equal(response.status(), 201);
  record = await response.json();
  assert.equal(record.lifecycle, "pending");
  assert.equal((await context.request.get(`${origin}/api/trade-record/${record.id}`)).status(), 404);
  await expect(button).toHaveText("공유 창 열기", { timeout: 30000 });
  await page.screenshot({ path: `${directory}/staging-prepared-mobile.png`, fullPage: true });
  const download = page.waitForEvent("download");
  await button.click();
  await (await download).saveAs(`${directory}/staging-trade-card.png`);
  const manager = page.locator("details.managed-records");
  // Readback independently confirms that the download action finalized it.
  await expect.poll(async () => (await context.request.get(`${origin}/api/trade-record/${record.id}`)).status(), { timeout: 20000 }).toBe(200);
  const verificationPage = await context.newPage();
  await verificationPage.goto(`${origin}/verify/?id=${record.id}`);
  await expect(verificationPage.getByText("서명 후 기록이 바뀌지 않았습니다.", { exact: true })).toBeVisible({ timeout: 20000 });
  await verificationPage.screenshot({ path: `${directory}/staging-verified-mobile.png`, fullPage: true });
  await verificationPage.close();
  if (await manager.count()) await manager.evaluate((element) => { element.open = true; });
  const revoke = page.getByRole("button", { name: `공개 기록 ${record.id} 링크 비활성화` });
  // The management details may use another class; open the containing details.
  await revoke.evaluate((element) => { const details = element.closest("details"); if (details) details.open = true; });
  page.once("dialog", (dialog) => dialog.accept());
  await revoke.click();
  await expect.poll(async () => (await context.request.get(`${origin}/api/trade-record/${record.id}`)).status(), { timeout: 20000 }).toBe(404);
  console.log("PASS real staging browser: prepare, private read blocked, PNG download, finalize, signature display, revoke");
} finally {
  if (record?.id && record?.revokeToken) {
    const result = await context.request.delete(`${origin}/api/trade-record/${record.id}`, { headers: { Authorization: `Bearer ${record.revokeToken}` } });
    assert.ok([200, 404, 410].includes(result.status()), "Synthetic record cleanup failed");
    assert.equal((await context.request.get(`${origin}/api/trade-record/${record.id}`)).status(), 404);
  }
  await context.close();
  await browser.close();
}
