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

export async function shareImageFile({
  file,
  title,
  text,
  nativeShare,
  nativeCanShare,
  download,
}) {
  file = await materializeShareFile(file);
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
