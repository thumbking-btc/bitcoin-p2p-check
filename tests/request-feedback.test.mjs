import assert from "node:assert/strict";
import test from "node:test";
import { InvoiceRequestError, readInvoiceResponse, tradeRecordPreparationFeedback, UNKNOWN_INVOICE_MESSAGE } from "../app/lib/request-feedback.mjs";

test("disabled records never imply a pending record exists or suggest retrying", () => {
  const failure = Object.assign(new Error("disabled"), { code: "TRADE_RECORDS_DISABLED" });
  const message = tradeRecordPreparationFeedback(failure);
  assert.match(message, /전체 기능 검수 환경/u);
  assert.doesNotMatch(message, /재시도|다시 시도|동일한 준비 기록/u);
  const timeout = Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" });
  assert.match(tradeRecordPreparationFeedback(timeout), /조건을 바꾸지 않고/u);
});

test("invoice responses distinguish explicit rejection from unknown issuance", async () => {
  const explicit = Response.json({ ok: false, code: "AMOUNT_NOT_SUPPORTED", message: "최소 금액을 확인하십시오.", issuanceStatus: "not-issued" }, { status: 422 });
  await assert.rejects(readInvoiceResponse(explicit), error => error instanceof InvoiceRequestError && !error.issuanceUnknown && /최소 금액/u.test(error.message));
  const unknown = Response.json({ ok: false, code: "PROVIDER_TIMEOUT", message: "timeout", issuanceStatus: "unknown" }, { status: 504 });
  await assert.rejects(readInvoiceResponse(unknown), error => error.issuanceUnknown && error.message === UNKNOWN_INVOICE_MESSAGE);
  const value = { ok: true, invoice: "sample", amountSats: 21 };
  assert.deepEqual(await readInvoiceResponse(Response.json(value)), value);
});

test("untrusted HTML, oversized and malformed responses do not expose diagnostics or promise failed issuance", async () => {
  for (const response of [
    new Response("<html>edge diagnostic secret</html>", {status: 502, headers:{"Content-Type":"text/html"}}),
    new Response("invalid JSON", {headers:{"Content-Type":"application/json"}}),
    Response.json({ok:true,invoice:"x".repeat(70_000)}),
    Response.json(null),
  ]) {
    await assert.rejects(readInvoiceResponse(response), error => error.issuanceUnknown && error.message === UNKNOWN_INVOICE_MESSAGE);
  }
});
