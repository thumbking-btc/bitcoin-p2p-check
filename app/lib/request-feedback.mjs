/** Keeps a configuration failure distinct from an uncertain network outcome. */
export function tradeRecordPreparationFeedback(reason) {
  const code = reason?.code;
  if (code === "TRADE_RECORDS_DISABLED") {
    return "오류: 이 화면에서는 거래 기록을 만들 수 없습니다. 전체 기능 검수 환경을 이용하십시오.";
  }
  if (code === "REQUEST_TIMEOUT" || reason?.name === "TradeRecordNetworkError") {
    return "오류: 기록 준비 결과를 받지 못했습니다. 조건을 바꾸지 않고 다시 시도하면 중복 생성을 방지할 수 있습니다.";
  }
  return `오류: ${reason instanceof Error ? reason.message : "거래 기록 카드를 준비하지 못했습니다."}`;
}

export const UNKNOWN_INVOICE_MESSAGE = "인보이스 발급 결과를 받지 못했습니다. 받는 지갑에서 확인한 뒤 새로 요청하거나 인보이스를 직접 입력하십시오.";

export class InvoiceRequestError extends Error {
  constructor(message, issuanceUnknown = false) {
    super(message);
    this.name = "InvoiceRequestError";
    this.issuanceUnknown = issuanceUnknown;
  }
}

/** Reads one issuance response. Never retries an invoice-producing request. */
export async function readInvoiceResponse(response) {
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json" || !response.body) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw new InvoiceRequestError(UNKNOWN_INVOICE_MESSAGE, true);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        void reader.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid response");
    if (!response.ok || data.ok !== true) {
      // Only a structured provider rejection can establish a known failure.
      const known = data.ok === false && typeof data.code === "string" && typeof data.message === "string";
      const unknown = !known || data.issuanceStatus === "unknown";
      throw new InvoiceRequestError(unknown ? UNKNOWN_INVOICE_MESSAGE : data.message.slice(0, 240), unknown);
    }
    return data;
  } catch (reason) {
    if (reason instanceof InvoiceRequestError) throw reason;
    throw new InvoiceRequestError(UNKNOWN_INVOICE_MESSAGE, true);
  } finally {
    reader.releaseLock();
  }
}
