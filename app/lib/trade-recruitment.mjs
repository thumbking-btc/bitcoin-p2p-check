import { parseBitcoinAmount, satsToBtcInput } from "./bitcoin-amount.mjs";

const NETWORK_LABELS = {
  onchain: "온체인",
  lightning: "라이트닝",
  both: "온체인·라이트닝",
};

function parsePremium(value) {
  const raw = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d{0,2})?$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= -100) return null;
  return Object.is(parsed, -0) ? 0 : parsed;
}

function formatPremium(value) {
  return value.toLocaleString("ko-KR", {
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}

function roundToThreeSignificantDigits(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 2);
  return Math.round(value / step) * step;
}

function formatApproximateKrw(value) {
  const rounded = roundToThreeSignificantDigits(Number(value));
  if (rounded === null) return "";
  return rounded >= 10_000 && rounded % 10_000 === 0
    ? `${(rounded / 10_000).toLocaleString("ko-KR")}만원`
    : `${rounded.toLocaleString("ko-KR")}원`;
}

function formatSats(value, allowFractionalMan = false) {
  if (value >= 10_000 && (allowFractionalMan || value % 10_000 === 0)) {
    return `${(value / 10_000).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}만 sats`;
  }
  return `${value.toLocaleString("ko-KR")} sats`;
}

function formatApproximateBitcoin(value, unit) {
  const roundedSats = roundToThreeSignificantDigits(Number(value));
  if (roundedSats === null) return "";
  return unit === "btc"
    ? `${satsToBtcInput(roundedSats)} BTC`
    : formatSats(roundedSats, true);
}

function formatAmount(value, unit, approximateKrw, approximateSats, bitcoinDisplayUnit) {
  const raw = String(value ?? "").replaceAll(",", "").trim();
  if (!raw) return { text: "", error: "위 계산기에서 거래 금액을 입력하세요." };

  if (unit === "krw") {
    if (!/^\d{1,15}$/.test(raw)) {
      return { text: "", error: "원화 거래 금액을 확인하세요." };
    }
    const amount = BigInt(raw);
    if (amount <= 0n) return { text: "", error: "거래 금액은 0보다 커야 합니다." };
    const exactKrw = amount % 10_000n === 0n
        ? `${(amount / 10_000n).toLocaleString("ko-KR")}만원`
        : `${amount.toLocaleString("ko-KR")}원`;
    const approximateBitcoin = formatApproximateBitcoin(approximateSats, bitcoinDisplayUnit);
    return {
      text: approximateBitcoin
        ? `${exactKrw} (약 ${approximateBitcoin})`
        : exactKrw,
      error: "",
    };
  }

  if (unit !== "sats" && unit !== "btc") {
    return { text: "", error: "거래 금액 단위를 확인하세요." };
  }

  const parsed = parseBitcoinAmount(raw, unit);
  if (parsed.error === "precision") {
    return { text: "", error: "BTC는 소수점 이하 8자리까지 입력하세요." };
  }
  if (parsed.error || parsed.sats === null) {
    return { text: "", error: "비트코인 거래 금액을 확인하세요." };
  }
  if (parsed.sats <= 0) return { text: "", error: "거래 금액은 0보다 커야 합니다." };

  const exactSats = formatSats(parsed.sats);
  const exactBtc = `${satsToBtcInput(parsed.sats)} BTC`;
  const approximateFiat = formatApproximateKrw(approximateKrw);
  const exactBitcoin = unit === "sats" ? exactSats : exactBtc;
  return {
    text: `${exactBitcoin}${approximateFiat ? ` (약 ${approximateFiat})` : ""}`,
    error: "",
  };
}

function normalizeMemo(value) {
  return String(value ?? "")
    .replaceAll("\r\n", "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Builds a public recruitment post from standing trade intent only.
 * Only rounded quote equivalents are accepted; funding-source categories and
 * settlement destinations are deliberately excluded.
 *
 * @param {{
 *   tradeRole: "buyer" | "seller";
 *   amountUnit: "krw" | "sats" | "btc";
 *   amountInput: string;
 *   sellerPremiumInput: string;
 *   approximateKrw?: number | null;
 *   approximateSats?: number | null;
 *   bitcoinDisplayUnit?: "sats" | "btc";
 *   network: "onchain" | "lightning" | "both";
 *   returningTraderEnabled?: boolean;
 *   returningTraderPremiumInput?: string;
 *   canShareKrwSource?: boolean;
 *   canVerifyIdentity?: boolean;
 *   memo?: string;
 * }} input
 * @returns {{ text: string; error: string }}
 */
export function buildTradeRecruitmentPost(input) {
  if (input?.tradeRole !== "buyer" && input?.tradeRole !== "seller") {
    return { text: "", error: "구매 또는 판매를 선택하세요." };
  }

  const amount = formatAmount(
    input.amountInput,
    input.amountUnit,
    input.approximateKrw,
    input.approximateSats,
    input.bitcoinDisplayUnit,
  );
  if (amount.error) return amount;

  const sellerPremium = parsePremium(input.sellerPremiumInput);
  if (sellerPremium === null) {
    return { text: "", error: "판매자 프리미엄은 -100%보다 큰 숫자로 입력하세요." };
  }

  const networkLabel = NETWORK_LABELS[input.network];
  if (!networkLabel) return { text: "", error: "전송 방식을 선택하세요." };

  let premiumText = `${formatPremium(sellerPremium)}%`;
  if (input.returningTraderEnabled) {
    const returningPremium = parsePremium(input.returningTraderPremiumInput);
    if (returningPremium === null) {
      return { text: "", error: "기존 거래자 우대 프리미엄을 입력하세요." };
    }
    if (returningPremium >= sellerPremium) {
      return { text: "", error: "기존 거래자 우대 프리미엄은 기본 프리미엄보다 낮아야 합니다." };
    }
    premiumText += ` (기존 거래자 ${formatPremium(returningPremium)}%)`;
  }

  const lines = [
    `${input.tradeRole === "buyer" ? "구매" : "판매"} / ${amount.text} / ${premiumText} / ${networkLabel}`,
  ];

  const canShareKrwSource = input.tradeRole === "buyer" && input.canShareKrwSource;
  if (canShareKrwSource && input.canVerifyIdentity) {
    lines.push("원화 출처 설명과 상호 신원확인 협의 가능합니다.");
  } else if (canShareKrwSource) {
    lines.push("원화 출처 설명 가능합니다.");
  } else if (input.canVerifyIdentity) {
    lines.push("상호 신원확인 협의 가능합니다.");
  }

  const memo = normalizeMemo(input.memo);
  if (memo) lines.push(memo);
  lines.push("DM 부탁드립니다.");
  return { text: lines.join("\n"), error: "" };
}

/**
 * Keeps manual preview edits intact when only a live quote changes. Structured
 * recruitment-field changes can opt into replacing the preview immediately.
 *
 * @param {{ preview: string; previousGenerated: string; nextGenerated: string; force?: boolean }} input
 */
export function syncTradeRecruitmentPreview(input) {
  const replace = Boolean(input.force) || input.preview === input.previousGenerated;
  const preview = replace ? input.nextGenerated : input.preview;
  const dirty = preview !== input.nextGenerated;
  return { preview, dirty };
}

/**
 * @param {string} text
 * @param {((value: string) => Promise<void>) | null | undefined} writeText
 * @param {((value: string) => boolean) | null | undefined} fallbackCopy
 * @returns {Promise<"copied" | "empty" | "failed">}
 */
export async function copyTradeRecruitmentText(text, writeText, fallbackCopy) {
  if (typeof text !== "string" || !text.trim()) return "empty";

  if (typeof writeText === "function") {
    let timeoutId;
    try {
      await Promise.race([
        writeText(text),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("clipboard timeout")), 1_200);
        }),
      ]);
      return "copied";
    } catch {
      // Some in-app browsers expose Clipboard API but reject the write.
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  if (typeof fallbackCopy === "function") {
    try {
      if (fallbackCopy(text)) return "copied";
    } catch {
      // The caller will show a manual-copy recovery message.
    }
  }

  return "failed";
}

/**
 * Opens the native text share sheet when available and falls back to copying.
 * Cancelling the share sheet is intentional and must not trigger a copy.
 *
 * @param {string} text
 * @param {((value: string) => Promise<void>) | null | undefined} shareText
 * @param {((value: string) => Promise<void>) | null | undefined} writeText
 * @param {((value: string) => boolean) | null | undefined} fallbackCopy
 * @returns {Promise<"shared" | "copied" | "empty" | "cancelled" | "failed">}
 */
export async function shareTradeRecruitmentText(text, shareText, writeText, fallbackCopy) {
  if (typeof text !== "string" || !text.trim()) return "empty";

  if (typeof shareText === "function") {
    try {
      await shareText(text);
      return "shared";
    } catch (error) {
      if (error && typeof error === "object" && error.name === "AbortError") return "cancelled";
    }
  }

  return copyTradeRecruitmentText(text, writeText, fallbackCopy);
}
