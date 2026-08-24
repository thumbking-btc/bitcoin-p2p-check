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

async function prepareShareFile(file) {
  file = await materializeShareFile(file);
  return normalizePngFilename(file);
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
