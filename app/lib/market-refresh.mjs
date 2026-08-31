export const MARKET_REFERENCE_REFRESH_INTERVAL_MS = 5 * 60_000;
export const MARKET_PRICE_FALLBACK_INTERVAL_MS = 60_000;
export const LIVE_PRICE_RECONNECT_DELAYS_MS = Object.freeze([
  15_000,
  30_000,
  60_000,
]);

export function getMarketRefreshInterval(livePriceActive = false) {
  return livePriceActive
    ? MARKET_REFERENCE_REFRESH_INTERVAL_MS
    : MARKET_PRICE_FALLBACK_INTERVAL_MS;
}

export function getLivePriceReconnectDelay(attempt) {
  const index = Math.min(
    Math.max(Number.isFinite(attempt) ? Math.trunc(attempt) : 0, 0),
    LIVE_PRICE_RECONNECT_DELAYS_MS.length - 1,
  );
  return LIVE_PRICE_RECONNECT_DELAYS_MS[index];
}

export function getMarketRefreshDelay(
  lastRequestAt,
  intervalMs,
  now = Date.now(),
) {
  if (!Number.isFinite(lastRequestAt) || lastRequestAt <= 0) return 0;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  const elapsed = Math.max(0, now - lastRequestAt);
  return Math.max(0, intervalMs - elapsed);
}
