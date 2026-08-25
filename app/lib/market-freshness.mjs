export const LIVE_STREAM_STALL_TIMEOUT_MS = 20_000;

/**
 * Applies a validated live price to an existing market snapshot while keeping
 * the independently refreshed premium and fee fields intact.
 *
 * @param {Record<string, any>} snapshot
 * @param {{ priceKrw: number; observedAtMs: number }} price
 */
export function withLiveMarketPrice(snapshot, price) {
  const priceObservedAt = new Date(price.observedAtMs).toISOString();
  return {
    ...snapshot,
    status: snapshot.sourceStatus?.premium === "current" ? "current" : "partial",
    priceKrw: price.priceKrw,
    priceObservedAt,
    sourceStatus: snapshot.sourceStatus
      ? { ...snapshot.sourceStatus, price: "current" }
      : snapshot.sourceStatus,
    staleAgeSeconds: snapshot.staleAgeSeconds
      ? { ...snapshot.staleAgeSeconds, price: null }
      : snapshot.staleAgeSeconds,
  };
}

/**
 * Merges a REST refresh with the latest live price. During a payment/share
 * lock, callers pass the accumulated deferred snapshot as `latestSnapshot` so
 * REST and WebSocket updates cannot overwrite one another from an old base.
 *
 * @param {Record<string, any>} restSnapshot
 * @param {Record<string, any> | null} latestSnapshot
 * @param {boolean} livePriceActive
 */
export function mergeRestMarketSnapshot(restSnapshot, latestSnapshot, livePriceActive) {
  if (!livePriceActive || !latestSnapshot?.priceKrw || !latestSnapshot.priceObservedAt) {
    return restSnapshot;
  }
  return withLiveMarketPrice(restSnapshot, {
    priceKrw: latestSnapshot.priceKrw,
    observedAtMs: new Date(latestSnapshot.priceObservedAt).getTime(),
  });
}

/**
 * Merges a live tick into the latest accumulated snapshot and refuses to move
 * the observed timestamp backwards.
 *
 * @param {Record<string, any> | null} latestSnapshot
 * @param {{ priceKrw: number; observedAtMs: number }} price
 * @returns {Record<string, any> | null}
 */
export function mergeLiveMarketSnapshot(latestSnapshot, price) {
  if (!latestSnapshot) return null;
  const currentObservedAt = latestSnapshot.priceObservedAt
    ? new Date(latestSnapshot.priceObservedAt).getTime()
    : 0;
  if (Number.isFinite(currentObservedAt) && currentObservedAt > price.observedAtMs) {
    return latestSnapshot;
  }
  return withLiveMarketPrice(latestSnapshot, price);
}

export function isLiveStreamStalled(
  lastMessageAtMs,
  now = Date.now(),
  timeoutMs = LIVE_STREAM_STALL_TIMEOUT_MS,
) {
  if (!Number.isFinite(lastMessageAtMs) || lastMessageAtMs <= 0) return true;
  if (!Number.isFinite(now) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return true;
  const ageMs = now - lastMessageAtMs;
  return ageMs < 0 || ageMs >= timeoutMs;
}

export function markMarketPriceStale(snapshot, now = Date.now()) {
  if (!snapshot) return null;
  const observedAtMs = snapshot.priceObservedAt ? Date.parse(snapshot.priceObservedAt) : Number.NaN;
  const staleAgeSeconds = Number.isFinite(observedAtMs) && Number.isFinite(now)
    ? Math.max(0, Math.floor((now - observedAtMs) / 1_000))
    : null;
  return {
    ...snapshot,
    status: "stale",
    sourceStatus: snapshot.sourceStatus
      ? { ...snapshot.sourceStatus, price: "stale" }
      : snapshot.sourceStatus,
    staleAgeSeconds: snapshot.staleAgeSeconds
      ? { ...snapshot.staleAgeSeconds, price: staleAgeSeconds }
      : snapshot.staleAgeSeconds,
  };
}
