const PRICE_MAX_AGE_MS = 5 * 60_000;

export function isReferenceShareable(
  { referenceMode, marketState, referenceTime },
  now = Date.now(),
) {
  if (referenceMode === "manual") return true;
  if (referenceMode !== "upbit" || marketState !== "ready" || !referenceTime) return false;
  const observedAt = new Date(referenceTime).getTime();
  if (!Number.isFinite(observedAt) || !Number.isFinite(now)) return false;
  return now - observedAt < PRICE_MAX_AGE_MS;
}

function isAbortError(error) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

export async function shareImageFile({
  file,
  title,
  text,
  nativeShare,
  nativeCanShare,
  download,
}) {
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
