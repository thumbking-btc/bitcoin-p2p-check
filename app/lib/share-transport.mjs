const PRICE_MAX_AGE_MS = 5 * 60_000;

export function isReferenceShareable(
  { marketState, referenceTime },
  now = Date.now(),
) {
  if (marketState !== "ready" || !referenceTime) return false;
  const observedAt = new Date(referenceTime).getTime();
  if (!Number.isFinite(observedAt) || !Number.isFinite(now)) return false;
  return now - observedAt < PRICE_MAX_AGE_MS;
}

function isAbortError(error) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

async function materializeShareFile(file) {
  if (file?.type !== "application/x-bitcoin-p2p-trade-image+json") return file;
  const { materializeTradeShareImage } = await import("./trade-share-image");
  return materializeTradeShareImage(file);
}

function compactTradeShareText(text) {
  if (typeof text !== "string") return text;
  const marker = "\n[가격 계산]\n";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return text;
  const verificationMarker = "\n\n거래 조건 검증하기:";
  const verificationIndex = text.indexOf(verificationMarker, markerIndex + marker.length);
  const head = text.slice(0, markerIndex).trimEnd();
  if (verificationIndex < 0) return head;
  return `${head}${text.slice(verificationIndex)}`;
}

function prepareShareText(text) {
  if (typeof document === "undefined") return text;
  const visibleText = document.documentElement.dataset.currentTradeShareText;
  if (visibleText) return visibleText;
  return document.documentElement.dataset.includePriceDetails === "false"
    ? compactTradeShareText(text)
    : text;
}

export async function shareImageFile({
  file,
  title,
  text,
  nativeShare,
  nativeCanShare,
  download,
}) {
  file = await materializeShareFile(file);
  text = prepareShareText(text);
  let canShareFile = false;
  if (typeof nativeShare === "function" && typeof nativeCanShare === "function") {
    try {
      canShareFile = nativeCanShare({ files: [file] });
    } catch {
      canShareFile = false;
    }
  }

  if (!canShareFile) {
    download(file);
    return "downloaded";
  }

  try {
    await nativeShare({ title, text, files: [file] });
    return "shared";
  } catch (error) {
    if (isAbortError(error)) return "cancelled";
    download(file);
    return "downloaded-after-error";
  }
}
