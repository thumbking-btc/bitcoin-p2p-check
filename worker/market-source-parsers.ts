const MAX_PRICE_OBSERVATION_AGE_MS = 2 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;

export type UpstreamFailure = "timeout" | "http" | "network" | "invalid";

export type PriceValue = {
  priceKrw: number;
  priceObservedAt: string;
  retrievedAt: string;
};

export type PremiumValue = {
  koreaPremium: number;
  retrievedAt: string;
};

export type FeeRates = {
  nextBlock: number;
  halfHour: number;
  hour: number;
};

export type FeeValue = {
  feeRates: FeeRates;
  retrievedAt: string;
};

export type SourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: UpstreamFailure };

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value: number): string | null {
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

export function parsePricePayload(
  payload: unknown,
  nowMs: number,
  retrievedAt: string,
): SourceResult<PriceValue> {
  const ticker = Array.isArray(payload) ? payload[0] : null;
  const priceKrw = finite(ticker?.trade_price);
  const tradeTimestamp = finite(ticker?.trade_timestamp);
  const priceObservedAt = tradeTimestamp === null ? null : isoTimestamp(tradeTimestamp);

  if (priceKrw === null || priceKrw <= 0 || tradeTimestamp === null || priceObservedAt === null) {
    return { ok: false, failure: "invalid" };
  }

  const observationAge = nowMs - tradeTimestamp;
  if (observationAge > MAX_PRICE_OBSERVATION_AGE_MS || observationAge < -MAX_FUTURE_CLOCK_SKEW_MS) {
    return { ok: false, failure: "invalid" };
  }

  return {
    ok: true,
    value: { priceKrw, priceObservedAt, retrievedAt },
  };
}

export function parsePremiumPayload(
  payload: unknown,
  retrievedAt: string,
): SourceResult<PremiumValue> {
  const data = payload as {
    data?: { records?: Array<{ code?: unknown; pair?: unknown; disparityRate?: unknown }> };
  } | null;
  const records = Array.isArray(data?.data?.records) ? data.data.records : [];
  const btcPremium = records.find((record) =>
    record?.code === "CRIX.UPBIT.KRW-BTC" || record?.pair === "BTC/KRW");
  const premiumPercent = finite(btcPremium?.disparityRate);
  const koreaPremium = premiumPercent === null ? null : premiumPercent / 100;

  if (koreaPremium === null || Math.abs(koreaPremium) > 0.5) {
    return { ok: false, failure: "invalid" };
  }

  return { ok: true, value: { koreaPremium, retrievedAt } };
}

export function parseFeePayload(
  payload: unknown,
  retrievedAt: string,
): SourceResult<FeeValue> {
  const data = payload as {
    fastestFee?: unknown;
    halfHourFee?: unknown;
    hourFee?: unknown;
    economyFee?: unknown;
    minimumFee?: unknown;
  } | null;
  const fastest = finite(data?.fastestFee);
  const halfHour = finite(data?.halfHourFee);
  const hour = finite(data?.hourFee);
  const economy = finite(data?.economyFee);
  const minimum = finite(data?.minimumFee);
  const values = [fastest, halfHour, hour, economy, minimum];

  if (
    values.some((value) => value === null || value <= 0 || value > 10_000)
    || fastest === null
    || halfHour === null
    || hour === null
    || economy === null
    || minimum === null
    || fastest < halfHour
    || halfHour < hour
    || hour < economy
    || economy < minimum
  ) {
    return { ok: false, failure: "invalid" };
  }

  return {
    ok: true,
    value: {
      feeRates: { nextBlock: fastest, halfHour, hour },
      retrievedAt,
    },
  };
}
