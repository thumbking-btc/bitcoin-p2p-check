const PRICE_MAX_AGE_MS = 5 * 60_000;
const TRADE_SHARE_REQUEST_TYPE = "application/x-bitcoin-p2p-trade-image+json";

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
  if (file?.type !== TRADE_SHARE_REQUEST_TYPE) return file;
  const { materializeTradeShareImage } = await import("./trade-share-image");
  return materializeTradeShareImage(file);
}

function normalizePngFilename(file) {
  if (file?.type !== "image/png" || typeof file.name !== "string" || /\.png$/iu.test(file.name)) return file;
  const basename = file.name.replace(/\.request$/iu, "").replace(/\.[^.]+$/u, "");
  return new File([file], `${basename || "bitcoin-p2p-trade"}.png`, {
    type: "image/png",
    lastModified: file.lastModified || Date.now(),
  });
}

async function runTradeImageTransform(file, transform) {
  if (typeof transform !== "function") return null;
  try {
    const transformed = await transform(file);
    return transformed?.type === "image/png" ? normalizePngFilename(transformed) : null;
  } catch {
    return null;
  }
}

async function prepareShareFile(file) {
  const transform = typeof window === "undefined"
    ? null
    : window.__p2pTransformTradeShareFile;

  // The current 4:3 renderer can build the final card directly from live trade
  // state. Give it the lightweight request before spending CPU and memory on the
  // legacy 1600x900 PNG that would otherwise be discarded immediately.
  if (file?.type === TRADE_SHARE_REQUEST_TYPE) {
    const directlyTransformed = await runTradeImageTransform(file, transform);
    if (directlyTransformed) return directlyTransformed;
  }

  file = await materializeShareFile(file);
  if (typeof window === "undefined" || file?.type !== "image/png") return file;

  // Keep the old PNG transform path as a compatibility fallback. It is reached
  // only when no direct request transform was available or that transform failed.
  return await runTradeImageTransform(file, transform) ?? file;
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
  file = await prepareShareFile(file);
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
