export const MARKET_REFRESH_WITH_LIVE_PRICE_MS = 60_000;
export const MARKET_REFRESH_FALLBACK_MS = 16_000;

export function getMarketRefreshInterval(livePriceActive) {
  return livePriceActive
    ? MARKET_REFRESH_WITH_LIVE_PRICE_MS
    : MARKET_REFRESH_FALLBACK_MS;
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
