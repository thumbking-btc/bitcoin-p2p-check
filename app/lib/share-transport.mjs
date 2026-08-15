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

/** Sensitive address/invoice images never fall back to an implicit download. */
export async function shareSensitiveImageFile({
  file,
  title,
  text,
  nativeShare,
  nativeCanShare,
}) {
  if (typeof nativeShare !== "function" || typeof nativeCanShare !== "function") return "unsupported";
  try {
    if (!nativeCanShare({ files: [file] })) return "unsupported";
  } catch {
    return "unsupported";
  }
  try {
    await nativeShare({ title, text, files: [file] });
    return "shared";
  } catch (error) {
    return isAbortError(error) ? "cancelled" : "failed";
  }
}
