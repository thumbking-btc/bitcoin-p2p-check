export const MARKET_REFRESH_INTERVAL_MS = 16_000;

export function getMarketRefreshDelay(lastRequestAt, now = Date.now()) {
  if (!Number.isFinite(lastRequestAt) || lastRequestAt <= 0) return 0;
  const elapsed = Math.max(0, now - lastRequestAt);
  return Math.max(0, MARKET_REFRESH_INTERVAL_MS - elapsed);
}
