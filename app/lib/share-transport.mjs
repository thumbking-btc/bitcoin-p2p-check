const PRICE_MAX_AGE_MS = 5 * 60_000;
const TRADE_SHARE_REQUEST_TYPE = "application/x-bitcoin-p2p-trade-image+json";

/** @typedef {"shared" | "cancelled" | "downloaded" | "downloaded-after-error"} ShareImageOutcome */
/** @typedef {"available" | "copied" | "copy-failed" | "unavailable"} VerificationUrlDelivery */
/**
 * @typedef {Readonly<{
 *   outcome: "downloaded" | "downloaded-after-error";
 *   verificationUrl: string | null;
 *   verificationUrlDelivery: VerificationUrlDelivery;
 * }>} DownloadFallbackDetails
 */
/**
 * @typedef {Readonly<{
 *   file: File;
 *   title: string;
 *   text: string;
 *   nativeShare?: ((data: ShareData) => Promise<void>) | null;
 *   nativeCanShare?: ((data: ShareData) => boolean) | null;
 *   download: (file: File) => void;
 *   verificationUrl?: string;
 *   copyVerificationUrl?: (url: string) => Promise<void> | void;
 *   onDownloadFallback?: (details: DownloadFallbackDetails) => Promise<void> | void;
 * }>} ShareImageFileOptions
 */

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

/**
 * @param {Readonly<{
 *   file: File;
 *   outcome: "downloaded" | "downloaded-after-error";
 *   download: (file: File) => void;
 *   verificationUrl?: string;
 *   copyVerificationUrl?: (url: string) => Promise<void> | void;
 *   onDownloadFallback?: (details: DownloadFallbackDetails) => Promise<void> | void;
 * }>} options
 * @returns {Promise<"downloaded" | "downloaded-after-error">}
 */
async function finishDownloadFallback({
  file,
  outcome,
  download,
  verificationUrl,
  copyVerificationUrl,
  onDownloadFallback,
}) {
  download(file);
  let verificationUrlDelivery = verificationUrl ? "available" : "unavailable";
  if (verificationUrl && typeof copyVerificationUrl === "function") {
    try {
      await copyVerificationUrl(verificationUrl);
      verificationUrlDelivery = "copied";
    } catch {
      verificationUrlDelivery = "copy-failed";
    }
  }
  if (typeof onDownloadFallback === "function") {
    try {
      await onDownloadFallback(Object.freeze({
        outcome,
        verificationUrl: verificationUrl || null,
        verificationUrlDelivery,
      }));
    } catch {
      // A status callback must never prevent the already-completed download.
    }
  }
  return outcome;
}

/**
 * Download fallbacks cannot carry clickable metadata inside a PNG. Callers
 * should pass the record verificationUrl and surface onDownloadFallback so a
 * copied link (or a manual copy action after copy-failed) accompanies the file.
 *
 * @param {ShareImageFileOptions} options
 * @returns {Promise<ShareImageOutcome>}
 */
export async function shareImageFile({
  file,
  title,
  text,
  nativeShare,
  nativeCanShare,
  download,
  verificationUrl = "",
  copyVerificationUrl = undefined,
  onDownloadFallback = undefined,
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
    return finishDownloadFallback({
      file,
      outcome: "downloaded",
      download,
      verificationUrl,
      copyVerificationUrl,
      onDownloadFallback,
    });
  }

  try {
    await nativeShare({ title, text, files: [file] });
    return "shared";
  } catch (error) {
    if (isAbortError(error)) return "cancelled";
    return finishDownloadFallback({
      file,
      outcome: "downloaded-after-error",
      download,
      verificationUrl,
      copyVerificationUrl,
      onDownloadFallback,
    });
  }
}
