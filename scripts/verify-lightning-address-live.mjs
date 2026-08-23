import { validateBolt11Invoice } from "../app/lib/bolt11-invoice.mjs";

const TEST_ADDRESSES = [
  "blankgrass886@walletofsatoshi.com",
  "holyseed@oksu.su",
];

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "BitcoinP2PCheckPreviewCompatibilityTest/1.0",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label}: JSON 응답이 아닙니다.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function chooseWholeSatAmount(info) {
  const minMsat = Number(info.minSendable);
  const maxMsat = Number(info.maxSendable);
  if (!Number.isSafeInteger(minMsat) || !Number.isSafeInteger(maxMsat) || minMsat < 1 || maxMsat < minMsat) {
    throw new Error("수취 금액 범위가 올바르지 않습니다.");
  }
  const minimumSats = Math.ceil(minMsat / 1_000);
  const maximumSats = Math.floor(maxMsat / 1_000);
  const amountSats = Math.max(21, minimumSats);
  if (amountSats > maximumSats) throw new Error("정수 사토시 시험 금액을 선택할 수 없습니다.");
  return amountSats;
}

for (const address of TEST_ADDRESSES) {
  const at = address.lastIndexOf("@");
  const username = address.slice(0, at);
  const domain = address.slice(at + 1);
  const discoveryUrl = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`;
  const info = await fetchJson(discoveryUrl, `${address} 조회`);
  if (info.status === "ERROR") throw new Error(`${address}: ${info.reason || "주소 조회 거절"}`);
  if (info.tag !== "payRequest" || typeof info.callback !== "string") {
    throw new Error(`${address}: LNURL-pay 주소가 아닙니다.`);
  }

  const amountSats = chooseWholeSatAmount(info);
  const callback = new URL(info.callback);
  callback.searchParams.set("amount", String(amountSats * 1_000));
  const payment = await fetchJson(callback, `${address} 인보이스 발급`);
  if (payment.status === "ERROR") throw new Error(`${address}: ${payment.reason || "인보이스 발급 거절"}`);
  if (typeof payment.pr !== "string") throw new Error(`${address}: BOLT11 인보이스가 없습니다.`);

  const invoice = validateBolt11Invoice(payment.pr, {
    expectedSats: BigInt(amountSats),
    minimumRemainingSeconds: 60,
  });
  console.log(`${address}: ${amountSats} sats 인보이스 검증 성공, 만료 ${invoice.expiresAt}`);
}
