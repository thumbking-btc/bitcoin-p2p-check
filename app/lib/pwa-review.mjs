export const PWA_REVIEW_QUERY_PARAM = "pwa-review";
export const PWA_REVIEW_STORAGE_KEY = "bitcoin-p2p-check-pwa-review";

/**
 * Enables PWA review only after an explicit `?pwa-review=1` visit and remembers
 * the choice on that origin so an installed preview can relaunch without the
 * query string. `?pwa-review=0` clears the local opt-in.
 *
 * @param {unknown} search
 * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void } | null | undefined} storage
 */
export function resolvePwaReviewOptIn(search, storage) {
  let explicit = null;
  if (typeof search === "string") {
    try {
      const value = new URLSearchParams(search).get(PWA_REVIEW_QUERY_PARAM);
      if (value === "1") explicit = true;
      if (value === "0") explicit = false;
    } catch {
      explicit = null;
    }
  }

  if (!storage) return explicit === true;
  try {
    if (explicit === true) {
      storage.setItem(PWA_REVIEW_STORAGE_KEY, "1");
      return true;
    }
    if (explicit === false) {
      storage.removeItem(PWA_REVIEW_STORAGE_KEY);
      return false;
    }
    return storage.getItem(PWA_REVIEW_STORAGE_KEY) === "1";
  } catch {
    return explicit === true;
  }
}
