"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calculateP2PQuote, SATS_PER_BTC, stepPremiumPercent } from "../lib/p2p-quote.mjs";
import { groupedBtcInput, normalizeBtcInput, parseBitcoinAmount, satsToBtcInput } from "../lib/bitcoin-amount.mjs";
import { isReferenceShareable, shareImageFile } from "../lib/share-transport.mjs";
import { buildTradeIntent } from "../lib/trade-share-copy.mjs";
import { buildTradeFragment, parseTradeFragment } from "../lib/trade-link.mjs";
import { readTradeDraft, writeTradeDraft } from "../lib/trade-draft.mjs";
import { createTradeShareImage, type TradeShareImageInput } from "../lib/trade-share-image";
import { TradeRecruitmentTool } from "./TradeRecruitmentTool";

type TradeRole = "buyer" | "seller";
type FocusedField = "krw" | "bitcoin" | null;
type BitcoinDisplayUnit = "btc" | "sats";
type AmountBasis = "krw" | "bitcoin";
type AmountInputUnit = "krw" | BitcoinDisplayUnit;
type MarketRefreshMode = "initial" | "manual" | "silent";
type ActiveMarketRefresh = {
  mode: MarketRefreshMode;
  promise: Promise<void>;
};

type LivePrice = {
  priceKrw: number;
  observedAtMs: number;
};

const UPBIT_TICKER_WEBSOCKET_URL = "wss://api.upbit.com/websocket/v1";
const LIVE_PRICE_RENDER_INTERVAL_MS = 1_000;
const LIVE_PRICE_RECONNECT_DELAY_MS = 12_000;
const MARKET_REFRESH_WITH_LIVE_PRICE_MS = 60_000;
const MARKET_REFRESH_FALLBACK_MS = 16_000;
const MAX_LIVE_PRICE_AGE_MS = 2 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;

const FUNDING_SOURCE_OPTIONS = [
  "기재하지 않음",
  "근로소득",
  "사업소득",
  "연금소득",
  "금융소득",
  "임대소득",
  "자산처분대금",
  "퇴직금",
  "상속·증여",
  "대출·차입금",
  "기존 보유자금",
  "기타소득",
] as const;
type FundingSource = (typeof FUNDING_SOURCE_OPTIONS)[number];

type TradeDraftFields = {
  tradeRole: TradeRole;
  krwAmounts: Record<TradeRole, string>;
  bitcoinAmountInputs: Record<TradeRole, string>;
  amountBasisByRole: Record<TradeRole, AmountBasis>;
  premiumInput: string;
  fundingSources: Record<TradeRole, FundingSource>;
  bitcoinDisplayUnit: BitcoinDisplayUnit;
};

const DEFAULT_TRADE_DRAFT: TradeDraftFields = {
  tradeRole: "buyer",
  krwAmounts: { buyer: "3000000", seller: "3000000" },
  bitcoinAmountInputs: { buyer: "3000000", seller: "3000000" },
  amountBasisByRole: { buyer: "krw", seller: "bitcoin" },
  premiumInput: "2",
  fundingSources: { buyer: "기재하지 않음", seller: "기재하지 않음" },
  bitcoinDisplayUnit: "sats",
};

function getTradeDraftStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function convertDraftBitcoinInputs(
  inputs: Record<TradeRole, string>,
  fromUnit: BitcoinDisplayUnit,
  toUnit: BitcoinDisplayUnit,
) {
  if (fromUnit === toUnit) return { ...inputs };
  return Object.fromEntries((Object.keys(inputs) as TradeRole[]).map((role) => {
    const parsed = parseBitcoinAmount(inputs[role], fromUnit);
    return [role, parsed.sats === null ? "" : toUnit === "btc" ? satsToBtcInput(parsed.sats) : String(parsed.sats)];
  })) as Record<TradeRole, string>;
}

type MarketSnapshot = {
  checkedAt: string;
  status: "current" | "partial" | "stale" | "unavailable";
  priceKrw: number | null;
  priceObservedAt: string | null;
  koreaPremium: number | null;
  feeRates?: {
    nextBlock: number;
    halfHour: number;
    hour: number;
  } | null;
  feeCheckedAt?: string | null;
  sourceStatus?: {
    price: "current" | "stale" | "unavailable";
    premium: "current" | "stale" | "unavailable";
    fees: "current" | "stale" | "unavailable";
  };
  staleAgeSeconds?: {
    price: number | null;
    premium: number | null;
    fees: number | null;
  };
};

async function requestMarketSnapshot(includePrice: boolean) {
  const response = await fetch(`/api/market?price=${includePrice ? "1" : "0"}`, { cache: "no-store" });
  if (!response.ok) throw new Error("market request failed");
  const data = await response.json() as MarketSnapshot;
  if (includePrice && (!Number.isFinite(data.priceKrw) || Number(data.priceKrw) <= 0)) {
    throw new Error("price unavailable");
  }
  return data;
}

function withLivePrice(snapshot: MarketSnapshot, price: LivePrice): MarketSnapshot {
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

async function parseUpbitTickerMessage(data: unknown): Promise<LivePrice | null> {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (data instanceof ArrayBuffer) {
    text = new TextDecoder().decode(data);
  } else if (data instanceof Blob) {
    text = await data.text();
  } else {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!value || typeof value !== "object") return null;
  const ticker = value as {
    code?: unknown;
    trade_price?: unknown;
    trade_timestamp?: unknown;
  };
  if (ticker.code !== "KRW-BTC") return null;

  const priceKrw = Number(ticker.trade_price);
  const observedAtMs = Number(ticker.trade_timestamp);
  if (!Number.isFinite(priceKrw) || priceKrw <= 0 || !Number.isFinite(observedAtMs)) return null;

  const ageMs = Date.now() - observedAtMs;
  if (ageMs > MAX_LIVE_PRICE_AGE_MS || ageMs < -MAX_FUTURE_CLOCK_SKEW_MS) return null;
  return { priceKrw, observedAtMs };
}

function digitsOnly(value: string, maximumDigits: number) {
  return value.replace(/\D/g, "").slice(0, maximumDigits);
}

function signedDecimalOnly(value: string, decimals: number) {
  const negative = value.trimStart().startsWith("-");
  const cleaned = value.replace(/[^\d.]/g, "");
  const [whole = "", ...fractionParts] = cleaned.split(".");
  const fraction = fractionParts.join("").slice(0, decimals);
  const unsigned = cleaned.includes(".") ? `${whole || "0"}.${fraction}` : whole;
  if (!unsigned) return negative ? "-" : "";
  return `${negative ? "-" : ""}${unsigned}`;
}

function numeric(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function grouped(value: string) {
  const parsed = numeric(value);
  return parsed === null ? value : parsed.toLocaleString("ko-KR");
}

function formatKrw(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function formatSats(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value).toLocaleString("ko-KR")} sats`;
}

function formatBtc(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value / SATS_PER_BTC).toLocaleString("ko-KR", { maximumFractionDigits: 8 })} BTC`;
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ko-KR", {
    style: "percent",
    signDisplay: "always",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTime(value: string | null | undefined) {
  if (!value) return "조회 시각 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "조회 시각 없음";
  return `${new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date)} KST`;
}

function formatClock(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function LiveMarketTime({
  active,
  tradeObservedAt,
}: {
  active: boolean;
  tradeObservedAt: string | null;
}) {
  const [currentTime, setCurrentTime] = useState<string | null>(null);

  useEffect(() => {
    let timer: number | null = null;
    const tick = () => {
      const now = Date.now();
      setCurrentTime(new Date(now).toISOString());
      timer = window.setTimeout(tick, 1_000 - (now % 1_000));
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (timer !== null) window.clearTimeout(timer);
      tick();
    };

    tick();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return (
    <span title={active ? `최근 체결: ${formatTime(tradeObservedAt)}` : undefined}>
      {active ? "실시간" : "연결 중"} · {formatTime(currentTime ?? tradeObservedAt)}
    </span>
  );
}

function formatFeeRate(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

function downloadTradeImage(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function P2PTradeTool() {
  const [tradeRole, setTradeRole] = useState<TradeRole>(DEFAULT_TRADE_DRAFT.tradeRole);
  const [krwAmounts, setKrwAmounts] = useState<Record<TradeRole, string>>({ ...DEFAULT_TRADE_DRAFT.krwAmounts });
  const [bitcoinAmountInputs, setBitcoinAmountInputs] = useState<Record<TradeRole, string>>({ ...DEFAULT_TRADE_DRAFT.bitcoinAmountInputs });
  const [amountBasisByRole, setAmountBasisByRole] = useState<Record<TradeRole, AmountBasis>>({ ...DEFAULT_TRADE_DRAFT.amountBasisByRole });
  const [premiumInput, setPremiumInput] = useState(DEFAULT_TRADE_DRAFT.premiumInput);
  const [fundingSources, setFundingSources] = useState<Record<TradeRole, FundingSource>>({ ...DEFAULT_TRADE_DRAFT.fundingSources });
  const [importedTradeLink, setImportedTradeLink] = useState(false);
  const [bitcoinDisplayUnit, setBitcoinDisplayUnit] = useState<BitcoinDisplayUnit>(DEFAULT_TRADE_DRAFT.bitcoinDisplayUnit);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const skipNextDraftPersistence = useRef(true);
  const [focusedField, setFocusedField] = useState<FocusedField>(null);
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [marketState, setMarketState] = useState<"loading" | "ready" | "error">("loading");
  const [marketError, setMarketError] = useState("");
  const [priceExpired, setPriceExpired] = useState(false);
  const [livePriceActive, setLivePriceActive] = useState(false);
  const [resultAnnouncement, setResultAnnouncement] = useState("");
  const [shareStatus, setShareStatus] = useState("");
  const [isSharing, setIsSharing] = useState(false);
  const [shareImageGeneration, setShareImageGeneration] = useState(0);
  const [preparedShareImage, setPreparedShareImage] = useState<{
    key: string;
    file: File | null;
    failed: boolean;
  } | null>(null);
  const marketRef = useRef<MarketSnapshot | null>(null);
  const marketRequestRef = useRef<ActiveMarketRefresh | null>(null);
  const lastMarketRefreshAtRef = useRef(0);
  const attemptedInitialMarketLoadRef = useRef(false);
  const livePriceActiveRef = useRef(false);
  const isSharingRef = useRef(false);
  const pendingMarketSnapshotRef = useRef<MarketSnapshot | null>(null);
  const suppressNextResultAnnouncementRef = useRef(false);
  const preparedShareFormKeyRef = useRef("");

  const applyMarketSnapshot = useCallback((data: MarketSnapshot, silent: boolean) => {
    const current = marketRef.current;
    const nextData = livePriceActiveRef.current && current?.priceKrw && current.priceObservedAt
      ? withLivePrice(data, {
          priceKrw: current.priceKrw,
          observedAtMs: new Date(current.priceObservedAt).getTime(),
        })
      : data;
    if (isSharingRef.current) {
      pendingMarketSnapshotRef.current = nextData;
      return;
    }
    suppressNextResultAnnouncementRef.current = silent;
    marketRef.current = nextData;
    setMarket(nextData);
    setMarketState("ready");
    setMarketError("");
    setPriceExpired(false);
  }, []);

  const applyLivePrice = useCallback((price: LivePrice) => {
    const current = marketRef.current;
    if (!current) return false;

    const currentObservedAt = current.priceObservedAt ? new Date(current.priceObservedAt).getTime() : 0;
    if (Number.isFinite(currentObservedAt) && currentObservedAt > price.observedAtMs) return true;

    const nextData = withLivePrice(current, price);
    if (isSharingRef.current) {
      pendingMarketSnapshotRef.current = nextData;
      return true;
    }

    suppressNextResultAnnouncementRef.current = true;
    marketRef.current = nextData;
    setMarket(nextData);
    setMarketState("ready");
    setMarketError("");
    setPriceExpired(false);
    return true;
  }, []);

  const refreshMarket = useCallback((mode: MarketRefreshMode) => {
    if (mode !== "silent") {
      setMarketState("loading");
      setMarketError("");
      setPriceExpired(false);
    }

    const activeRefresh = marketRequestRef.current;
    if (activeRefresh) {
      if (mode !== "silent") activeRefresh.mode = mode;
      return activeRefresh.promise;
    }

    const refresh: ActiveMarketRefresh = {
      mode,
      promise: Promise.resolve(),
    };
    const includePrice = !livePriceActiveRef.current;
    refresh.promise = requestMarketSnapshot(includePrice).then(
      (data) => applyMarketSnapshot(data, refresh.mode === "silent"),
      () => {
        if (refresh.mode === "silent" && marketRef.current) return;
        setMarketState("error");
        setPriceExpired(true);
        setMarketError(refresh.mode === "manual"
          ? "시세를 새로 불러오지 못했습니다. 마지막 조회값은 확인용으로만 표시하며 공유할 수 없습니다."
          : "업비트 최근 체결가를 불러오지 못했습니다. 잠시 후 시세 새로고침을 눌러 다시 확인하세요.");
      },
    ).finally(() => {
      lastMarketRefreshAtRef.current = Date.now();
      if (marketRequestRef.current === refresh) marketRequestRef.current = null;
    });
    marketRequestRef.current = refresh;
    return refresh.promise;
  }, [applyMarketSnapshot]);

  const loadMarket = useCallback(async () => {
    await refreshMarket("manual");
  }, [refreshMarket]);

  const marketRefreshIntervalMs = livePriceActive
    ? MARKET_REFRESH_WITH_LIVE_PRICE_MS
    : MARKET_REFRESH_FALLBACK_MS;

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const getRefreshDelay = () => {
      const lastRequestAt = lastMarketRefreshAtRef.current;
      if (!Number.isFinite(lastRequestAt) || lastRequestAt <= 0) return 0;
      const elapsed = Math.max(0, Date.now() - lastRequestAt);
      return Math.max(0, marketRefreshIntervalMs - elapsed);
    };

    const schedule = () => {
      clearTimer();
      if (disposed || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => void runWhenDue(), Math.max(1, getRefreshDelay()));
    };

    const runWhenDue = async () => {
      clearTimer();
      if (disposed || document.visibilityState !== "visible") return;
      const delay = getRefreshDelay();
      if (delay > 0) {
        timer = window.setTimeout(() => void runWhenDue(), delay);
        return;
      }
      const mode: MarketRefreshMode = attemptedInitialMarketLoadRef.current ? "silent" : "initial";
      attemptedInitialMarketLoadRef.current = true;
      await refreshMarket(mode);
      if (!disposed) schedule();
    };

    const handleVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState === "visible") void runWhenDue();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (document.visibilityState === "visible") void runWhenDue();
    return () => {
      disposed = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [marketRefreshIntervalMs, refreshMarket]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let renderTimer: number | null = null;
    let lastRenderedAt = 0;
    let queuedPrice: LivePrice | null = null;

    const setStreamActive = (active: boolean) => {
      livePriceActiveRef.current = active;
      setLivePriceActive(active);
    };

    const clearReconnectTimer = () => {
      if (reconnectTimer === null) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const clearRenderTimer = () => {
      if (renderTimer === null) return;
      window.clearTimeout(renderTimer);
      renderTimer = null;
    };

    const flushQueuedPrice = () => {
      clearRenderTimer();
      const price = queuedPrice;
      queuedPrice = null;
      if (!price || disposed) return;
      lastRenderedAt = Date.now();
      if (applyLivePrice(price)) setStreamActive(true);
    };

    const queuePrice = (price: LivePrice) => {
      if (queuedPrice && queuedPrice.observedAtMs > price.observedAtMs) return;
      queuedPrice = price;
      const elapsed = Date.now() - lastRenderedAt;
      if (elapsed >= LIVE_PRICE_RENDER_INTERVAL_MS) {
        flushQueuedPrice();
        return;
      }
      if (renderTimer === null) {
        renderTimer = window.setTimeout(flushQueuedPrice, LIVE_PRICE_RENDER_INTERVAL_MS - elapsed);
      }
    };

    const scheduleReconnect = () => {
      clearReconnectTimer();
      if (disposed) return;
      reconnectTimer = window.setTimeout(connect, LIVE_PRICE_RECONNECT_DELAY_MS);
    };

    const connect = () => {
      if (disposed) return;
      clearReconnectTimer();
      const nextSocket = new WebSocket(UPBIT_TICKER_WEBSOCKET_URL);
      nextSocket.binaryType = "arraybuffer";
      socket = nextSocket;

      nextSocket.onopen = () => {
        if (disposed || socket !== nextSocket) return;
        nextSocket.send(JSON.stringify([
          { ticket: `bitcoin-p2p-check-${Date.now()}` },
          { type: "ticker", codes: ["KRW-BTC"] },
        ]));
      };

      nextSocket.onmessage = (event) => {
        void parseUpbitTickerMessage(event.data).then((price) => {
          if (!price || disposed || socket !== nextSocket) return;
          queuePrice(price);
        });
      };

      nextSocket.onerror = () => {
        if (socket === nextSocket) nextSocket.close();
      };

      nextSocket.onclose = () => {
        if (socket !== nextSocket) return;
        socket = null;
        setStreamActive(false);
        scheduleReconnect();
      };
    };

    connect();
    return () => {
      disposed = true;
      clearReconnectTimer();
      clearRenderTimer();
      setStreamActive(false);
      const activeSocket = socket;
      socket = null;
      activeSocket?.close();
    };
  }, [applyLivePrice]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const imported = parseTradeFragment(window.location.hash);
      const storage = getTradeDraftStorage();
      const stored = readTradeDraft(storage);
      const hydratedDraft: TradeDraftFields = stored ? {
        tradeRole: stored.tradeRole as TradeRole,
        krwAmounts: { ...stored.krwAmounts },
        bitcoinAmountInputs: { ...stored.bitcoinAmountInputs },
        amountBasisByRole: { ...stored.amountBasisByRole },
        premiumInput: stored.premiumInput,
        fundingSources: { ...stored.fundingSources },
        bitcoinDisplayUnit: stored.bitcoinDisplayUnit as BitcoinDisplayUnit,
      } : {
        ...DEFAULT_TRADE_DRAFT,
        krwAmounts: { ...DEFAULT_TRADE_DRAFT.krwAmounts },
        bitcoinAmountInputs: { ...DEFAULT_TRADE_DRAFT.bitcoinAmountInputs },
        amountBasisByRole: { ...DEFAULT_TRADE_DRAFT.amountBasisByRole },
        fundingSources: { ...DEFAULT_TRADE_DRAFT.fundingSources },
      };

      if (imported) {
        const importedRole: TradeRole = imported.side === "buy" ? "buyer" : "seller";
        const importedBasis = imported.amountBasis as AmountBasis;
        const importedDisplayUnit = imported.displayUnit as BitcoinDisplayUnit;
        hydratedDraft.tradeRole = importedRole;
        hydratedDraft.amountBasisByRole[importedRole] = importedBasis;
        hydratedDraft.bitcoinAmountInputs = convertDraftBitcoinInputs(
          hydratedDraft.bitcoinAmountInputs,
          hydratedDraft.bitcoinDisplayUnit,
          importedDisplayUnit,
        );
        if (importedBasis === "krw") {
          hydratedDraft.krwAmounts[importedRole] = String(imported.amount);
        } else {
          hydratedDraft.bitcoinAmountInputs[importedRole] = importedDisplayUnit === "btc"
            ? satsToBtcInput(imported.amount)
            : String(imported.amount);
        }
        hydratedDraft.premiumInput = String(imported.premium);
        hydratedDraft.fundingSources[importedRole] = imported.fundingSource as FundingSource;
        hydratedDraft.bitcoinDisplayUnit = importedDisplayUnit;
        setImportedTradeLink(true);
        writeTradeDraft(storage, hydratedDraft);
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      }

      setTradeRole(hydratedDraft.tradeRole);
      setKrwAmounts(hydratedDraft.krwAmounts);
      setBitcoinAmountInputs(hydratedDraft.bitcoinAmountInputs);
      setAmountBasisByRole(hydratedDraft.amountBasisByRole);
      setPremiumInput(hydratedDraft.premiumInput);
      setFundingSources(hydratedDraft.fundingSources);
      setBitcoinDisplayUnit(hydratedDraft.bitcoinDisplayUnit);
      setDraftHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!draftHydrated) return;
    if (skipNextDraftPersistence.current) {
      skipNextDraftPersistence.current = false;
      return;
    }
    writeTradeDraft(getTradeDraftStorage(), {
      tradeRole,
      krwAmounts,
      bitcoinAmountInputs,
      amountBasisByRole,
      premiumInput,
      fundingSources,
      bitcoinDisplayUnit,
    });
  }, [amountBasisByRole, bitcoinAmountInputs, bitcoinDisplayUnit, draftHydrated, fundingSources, krwAmounts, premiumInput, tradeRole]);

  useEffect(() => {
    if (!market?.priceObservedAt) return;
    const observedAt = new Date(market.priceObservedAt).getTime();
    if (!Number.isFinite(observedAt)) return;
    const remaining = Math.max(0, 5 * 60_000 - (Date.now() - observedAt));
    const timeout = window.setTimeout(() => setPriceExpired(true), remaining);
    return () => window.clearTimeout(timeout);
  }, [market?.priceObservedAt]);

  const premiumPercent = premiumInput === "" || premiumInput === "-" ? null : numeric(premiumInput);
  const premiumError = premiumPercent === null
    ? "판매자 프리미엄을 입력하세요."
    : premiumPercent <= -100
      ? "판매자 프리미엄은 -100%보다 크게 입력하세요."
      : "";
  const premiumWarning = premiumPercent !== null && premiumPercent > -100 && Math.abs(premiumPercent) >= 10;
  const referencePrice = market?.priceKrw ?? null;
  const referenceLabel = "업비트 최근 체결가";
  const referenceTime = market?.priceObservedAt ?? null;
  const fundingSource = fundingSources[tradeRole];
  const fundingSourceFieldLabel = "구매자 자금 출처";
  const amountBasis = amountBasisByRole[tradeRole];
  const krwAmount = krwAmounts[tradeRole];
  const bitcoinAmountInput = bitcoinAmountInputs[tradeRole];
  const amountInputUnit: AmountInputUnit = amountBasis === "krw" ? "krw" : bitcoinDisplayUnit;
  const amountInputLabel = amountBasis === "krw"
    ? tradeRole === "buyer" ? "보낼 원화" : "받을 원화"
    : tradeRole === "buyer"
      ? bitcoinDisplayUnit === "btc" ? "받을 BTC" : "받을 사토시"
      : bitcoinDisplayUnit === "btc" ? "보낼 BTC" : "보낼 사토시";
  const parsedBitcoinAmount = parseBitcoinAmount(bitcoinAmountInput, bitcoinDisplayUnit);
  const amount = amountBasis === "krw" ? numeric(krwAmount) : parsedBitcoinAmount.sats;
  const bitcoinAmountError = amountBasis !== "bitcoin" || !bitcoinAmountInput.trim()
    ? ""
    : parsedBitcoinAmount.error === "precision"
      ? "BTC는 소수점 이하 8자리까지 입력하세요."
      : parsedBitcoinAmount.error === "range"
        ? "비트코인 수량이 지원 범위를 넘었습니다."
        : parsedBitcoinAmount.error === "format"
          ? "비트코인 수량을 확인하세요."
          : "";

  const quote = useMemo(() => {
    if (amount === null || referencePrice === null || premiumPercent === null) return null;
    return calculateP2PQuote({
      mode: amountBasis === "krw" ? "krw" : "sats",
      amount,
      referencePrice,
      premiumPercent,
    });
  }, [amount, amountBasis, premiumPercent, referencePrice]);

  const multiplier = premiumPercent === null ? null : 1 + premiumPercent / 100;
  const premiumSummary = premiumPercent === null
    ? "판매자 프리미엄을 입력하세요."
    : premiumPercent > 0
      ? `판매자가 기준 시세보다 ${premiumPercent.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}% 높은 단가로 팝니다.`
      : premiumPercent < 0
        ? `판매자가 기준 시세보다 ${Math.abs(premiumPercent).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}% 낮은 단가로 팝니다.`
        : "판매자가 기준 시세와 같은 단가로 팝니다.";
  const stalePrice = market !== null
    && (priceExpired || market.status === "stale" || marketState === "error");
  const resultUnavailable = premiumError || bitcoinAmountError
    ? premiumError || bitcoinAmountError
    : referencePrice === null
      ? marketState === "loading" ? "업비트 시세를 불러오는 중입니다." : "최신 업비트 시세를 불러오지 못했습니다. 잠시 후 새로고침하세요."
      : amount === null || amount <= 0
        ? "거래 금액을 입력하세요."
        : "입력값을 확인하세요.";

  const effectiveKoreaPremium = marketState === "ready" && !stalePrice && market?.status === "current"
    ? market?.koreaPremium ?? null
    : null;
  const feeRates = market?.feeRates ?? null;
  const feeState = market?.sourceStatus?.fees ?? "unavailable";
  const feeVisualState = marketState === "loading" ? "loading" : feeState;
  const feeStatus = marketState === "loading"
    ? market ? "갱신 중" : "조회 중"
    : feeState === "current"
      ? `약 1분마다 자동 갱신 · ${formatClock(market?.feeCheckedAt) || "최신"}`
      : feeState === "stale"
        ? `저장된 값 · ${Math.max(1, Math.ceil((market?.staleAgeSeconds?.fees ?? 0) / 60))}분 전`
        : "조회 불가";

  const currentResultAnnouncement = quote && multiplier !== null
    ? tradeRole === "buyer"
      ? `구매 조건. 내가 보낼 원화 ${formatKrw(quote.paymentKrw)}, 내가 받을 비트코인 ${bitcoinDisplayUnit === "btc" ? formatBtc(quote.sats) : formatSats(quote.sats)}. ${amountBasis === "krw" ? "원화 금액" : "비트코인 수량"} 기준.`
      : `판매 조건. 내가 보낼 비트코인 ${bitcoinDisplayUnit === "btc" ? formatBtc(quote.sats) : formatSats(quote.sats)}, 내가 받을 원화 ${formatKrw(quote.paymentKrw)}. ${amountBasis === "krw" ? "원화 금액" : "비트코인 수량"} 기준.`
    : resultUnavailable;

  useEffect(() => {
    if (suppressNextResultAnnouncementRef.current) {
      suppressNextResultAnnouncementRef.current = false;
      return;
    }
    setResultAnnouncement(currentResultAnnouncement);
  }, [currentResultAnnouncement, market]);

  const tradeIntent = quote ? buildTradeIntent({
    tradeRole,
    amountBasis,
    paymentKrw: quote.paymentKrw,
    sats: quote.sats,
    bitcoinDisplayUnit,
  }) : "";
  const shareText = quote && multiplier !== null && tradeIntent ? [
    tradeIntent,
    `계산 시각: ${formatTime(referenceTime)}`,
    `구매자 → 판매자: ${formatKrw(quote.paymentKrw)}`,
    `판매자 → 구매자: ${bitcoinDisplayUnit === "btc" ? formatBtc(quote.sats) : formatSats(quote.sats)} (${bitcoinDisplayUnit === "btc" ? formatSats(quote.sats) : formatBtc(quote.sats)})`,
    `구매자 자금 출처: ${fundingSource} (구매자 제공 정보 · 거래 전 상호 확인)`,
    "",
    "[가격 계산]",
    `금액 기준: ${amountBasis === "krw" ? "원화 금액" : "비트코인 수량"}`,
    `기준: ${referenceLabel} ${formatKrw(referencePrice)} / BTC`,
    `판매자 프리미엄: ${premiumPercent}%`,
    `판매자가 파는 BTC 가격: ${formatKrw(quote.appliedPrice)} / BTC`,
    `참고 업비트 프리미엄: ${formatPercent(effectiveKoreaPremium)}`,
    "온체인 수수료: 판매자 부담 · 구매자 수령량 차감 없음",
    "확인용: 원화 입금·BTC 수령 증빙 아님",
  ].join("\n") : "";

  const shareImageInput = useMemo<TradeShareImageInput | null>(() => {
    if (!quote || referencePrice === null || premiumPercent === null) return null;
    return {
      tradeRole,
      amountBasis,
      bitcoinDisplayUnit,
      referenceLabel,
      referencePriceKrw: referencePrice,
      referenceTime,
      koreaPremiumRatio: effectiveKoreaPremium,
      sellerPremiumPercent: premiumPercent,
      buyerFundingSource: fundingSource,
      paymentKrw: quote.paymentKrw,
      sats: quote.sats,
      btcAmount: quote.sats / SATS_PER_BTC,
      appliedPriceKrw: quote.appliedPrice,
    };
  }, [amountBasis, bitcoinDisplayUnit, effectiveKoreaPremium, fundingSource, premiumPercent, quote, referenceLabel, referencePrice, referenceTime, tradeRole]);

  const shareImageKey = shareImageInput ? JSON.stringify(shareImageInput) : "";
  const shareFormKey = JSON.stringify({
    tradeRole,
    amountBasis,
    bitcoinDisplayUnit,
    amount,
    premiumPercent,
    fundingSource,
  });
  const shareImageAllowed = Boolean(shareImageInput)
    && draftHydrated
    && !stalePrice
    && marketState === "ready";
  const preparedShareFile = preparedShareImage?.key === shareImageKey ? preparedShareImage.file : null;
  const shareImageFailed = preparedShareImage?.key === shareImageKey && preparedShareImage.failed;
  const shareImagePreparing = shareImageAllowed && !preparedShareFile && !shareImageFailed;
  const backgroundShareImagePreparing = shareImagePreparing && Boolean(preparedShareImage?.file);
  const shareStatusIsError = Boolean(shareStatus) && (shareImageFailed || shareStatus.includes("못") || shareStatus.includes("다시"));

  useEffect(() => {
    if (!shareImageInput || !shareImageAllowed) return;
    let active = true;
    const timeout = window.setTimeout(() => {
      void createTradeShareImage(shareImageInput).then(
        (file) => {
          if (!active) return;
          const formChanged = preparedShareFormKeyRef.current !== shareFormKey;
          preparedShareFormKeyRef.current = shareFormKey;
          setPreparedShareImage({ key: shareImageKey, file, failed: false });
          setShareStatus((current) => formChanged || current === "공유할 거래 조건을 준비하지 못했습니다. 다시 시도해 주세요." ? "" : current);
        },
        () => {
          if (!active) return;
          setPreparedShareImage({ key: shareImageKey, file: null, failed: true });
          setShareStatus("공유할 거래 조건을 준비하지 못했습니다. 다시 시도해 주세요.");
        },
      );
    }, 80);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [shareFormKey, shareImageAllowed, shareImageGeneration, shareImageInput, shareImageKey]);

  async function shareTrade() {
    if (shareImageFailed) {
      setShareStatus("");
      setPreparedShareImage(null);
      setShareImageGeneration((value) => value + 1);
      return;
    }
    if (!shareText || !preparedShareFile || isSharing) return;
    if (stalePrice || !isReferenceShareable({ marketState, referenceTime }, Date.now())) {
      setPriceExpired(true);
      setShareStatus("최신 시세를 다시 조회한 뒤 거래 조건을 공유해 주세요.");
      return;
    }
    const tradeFragment = buildTradeFragment({
      side: tradeRole === "buyer" ? "buy" : "sell",
      amount: amount ?? "",
      amountBasis,
      premium: premiumPercent ?? "",
      fundingSource,
      displayUnit: bitcoinDisplayUnit,
    });
    const tradeLink = tradeFragment ? `${window.location.origin}/${tradeFragment}` : "";
    const textWithLink = tradeLink
      ? `${shareText}\n\n현재 시세로 다시 계산하기: ${tradeLink}`
      : shareText;
    setShareStatus("");
    isSharingRef.current = true;
    setIsSharing(true);
    try {
      const outcome = await shareImageFile({
        file: preparedShareFile,
        title: tradeIntent,
        text: textWithLink,
        nativeShare: typeof navigator.share === "function" ? navigator.share.bind(navigator) : null,
        nativeCanShare: typeof navigator.canShare === "function" ? navigator.canShare.bind(navigator) : null,
        download: downloadTradeImage,
      });
      if (outcome === "shared") {
        setShareStatus("현재 거래 조건을 공유했습니다.");
      } else if (outcome === "downloaded") {
        setShareStatus("PNG 이미지를 저장했습니다. 메신저에 첨부해 주세요.");
      } else if (outcome === "downloaded-after-error") {
        setShareStatus("공유 창을 열지 못해 PNG 이미지를 저장했습니다.");
      }
    } catch {
      setShareStatus("거래 조건을 공유하거나 이미지를 저장하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      isSharingRef.current = false;
      setIsSharing(false);
      const pendingSnapshot = pendingMarketSnapshotRef.current;
      if (pendingSnapshot) {
        pendingMarketSnapshotRef.current = null;
        applyMarketSnapshot(pendingSnapshot, true);
      }
    }
  }

  function changeBitcoinDisplayUnit(nextUnit: BitcoinDisplayUnit) {
    if (nextUnit === bitcoinDisplayUnit) return;
    setBitcoinAmountInputs((current) => Object.fromEntries(
      (Object.keys(current) as TradeRole[]).map((role) => {
        const parsed = parseBitcoinAmount(current[role], bitcoinDisplayUnit);
        return [role, parsed.sats === null ? "" : nextUnit === "btc" ? satsToBtcInput(parsed.sats) : String(parsed.sats)];
      }),
    ) as Record<TradeRole, string>);
    setBitcoinDisplayUnit(nextUnit);
    setFocusedField(null);
  }

  function changeAmountInputUnit(nextUnit: AmountInputUnit) {
    if (nextUnit === "krw") {
      if (quote) setKrwAmounts((current) => ({ ...current, [tradeRole]: String(quote.paymentKrw) }));
      setAmountBasisByRole((current) => ({ ...current, [tradeRole]: "krw" }));
      setFocusedField(null);
      return;
    }

    const nextDisplayUnit: BitcoinDisplayUnit = nextUnit;
    setBitcoinAmountInputs((current) => Object.fromEntries(
      (Object.keys(current) as TradeRole[]).map((role) => {
        if (role === tradeRole && quote) {
          return [role, nextDisplayUnit === "btc" ? satsToBtcInput(quote.sats) : String(quote.sats)];
        }
        const parsed = parseBitcoinAmount(current[role], bitcoinDisplayUnit);
        return [role, parsed.sats === null ? "" : nextDisplayUnit === "btc" ? satsToBtcInput(parsed.sats) : String(parsed.sats)];
      }),
    ) as Record<TradeRole, string>);
    setBitcoinDisplayUnit(nextDisplayUnit);
    setAmountBasisByRole((current) => ({ ...current, [tradeRole]: "bitcoin" }));
    setFocusedField(null);
  }

  function adjustPremium(direction: -1 | 1) {
    const nextPremium = stepPremiumPercent(premiumPercent, direction);
    if (nextPremium !== null) setPremiumInput(String(nextPremium));
  }

  return (
    <section
      className={`trade-tool ${draftHydrated ? "is-draft-hydrated" : "is-draft-hydrating"}`}
      aria-labelledby="tool-title"
      aria-busy={!draftHydrated}
    >
      <article className="capture-card" data-capture-card>
        <header className="tool-heading">
          <div className="brand-line">
            <span className="brand-mark" aria-hidden="true">₿</span>
            <h1 id="tool-title">비트코인 P2P 계산기</h1>
          </div>
          <button
            className="refresh-button"
            type="button"
            aria-label={marketState === "loading" ? "업비트 시세와 온체인 수수료율 조회 중" : "업비트 시세와 온체인 수수료율 새로고침"}
            onClick={() => void loadMarket()}
            disabled={marketState === "loading" || isSharing}
          >
            {marketState === "loading" ? "시세 조회 중" : "시세 새로고침"}
          </button>
        </header>

        <div className="market-strip" aria-label="거래 계산 기준과 시장 참고값">
          <div className="market-cell">
            <span>{referenceLabel}</span>
            <strong>{formatKrw(referencePrice)} <small>/ BTC</small></strong>
            <small className="live-market-time">
              <LiveMarketTime active={livePriceActive} tradeObservedAt={referenceTime} />
            </small>
          </div>
          <div className="market-cell">
            <span>업비트 프리미엄</span>
            <strong>{formatPercent(effectiveKoreaPremium)}</strong>
            <small>업비트 데이터랩 · 시장 참고값</small>
          </div>
        </div>
        {stalePrice ? (
          <p className="stale-warning" role="status">
            {marketState === "error"
              ? "시세 갱신에 실패했습니다. 마지막 조회값으로는 이미지를 공유할 수 없습니다."
              : market?.status === "stale"
                ? "최신 시세를 확인하지 못해 마지막 조회값을 표시합니다. 새로고침 후 거래 조건을 다시 확인하세요."
                : "5분 이상 지난 시세입니다. 새로고침 후 거래 조건을 다시 확인하세요."}
          </p>
        ) : null}
        {importedTradeLink ? (
          <p className="imported-trade-notice" role="status">
            공유된 입력값을 현재 업비트 시세로 다시 계산했습니다. 링크 값은 수정될 수 있으니 거래 전에 확인하세요.
          </p>
        ) : null}

        <fieldset className="role-fieldset">
          <legend>
            <span>나는 비트코인을</span>
            <small>시세는 합의의 기준일 뿐입니다.</small>
          </legend>
          <div className="role-options">
            <label htmlFor="trade-role-buyer" aria-label="비트코인을 삽니다. 원화를 보내고 비트코인을 받습니다.">
              <input id="trade-role-buyer" type="radio" name="trade-role" checked={tradeRole === "buyer"} onChange={() => setTradeRole("buyer")} />
              <span><strong>삽니다</strong><small>원화 보내고 BTC 받기</small></span>
            </label>
            <label htmlFor="trade-role-seller" aria-label="비트코인을 팝니다. 비트코인을 보내고 원화를 받습니다.">
              <input id="trade-role-seller" type="radio" name="trade-role" checked={tradeRole === "seller"} onChange={() => setTradeRole("seller")} />
              <span><strong>팝니다</strong><small>BTC 보내고 원화 받기</small></span>
            </label>
          </div>
        </fieldset>

        <form className="trade-form" onSubmit={(event) => event.preventDefault()}>
          <div className="field">
            <label htmlFor="trade-amount">{amountInputLabel}</label>
            <span className="input-with-unit">
              <input
                id="trade-amount"
                inputMode={amountBasis === "krw" || bitcoinDisplayUnit === "sats" ? "numeric" : "decimal"}
                value={amountBasis === "krw"
                  ? focusedField === "krw" ? krwAmount : grouped(krwAmount)
                  : focusedField === "bitcoin"
                    ? bitcoinAmountInput
                    : bitcoinDisplayUnit === "btc" ? groupedBtcInput(bitcoinAmountInput) : grouped(bitcoinAmountInput)}
                onFocus={() => setFocusedField(amountBasis === "krw" ? "krw" : "bitcoin")}
                onBlur={() => setFocusedField(null)}
                onChange={(event) => {
                  if (amountBasis === "krw") {
                    setKrwAmounts((current) => ({ ...current, [tradeRole]: digitsOnly(event.target.value, 15) }));
                    return;
                  }
                  if (bitcoinDisplayUnit === "sats") {
                    setBitcoinAmountInputs((current) => ({ ...current, [tradeRole]: digitsOnly(event.target.value, 16) }));
                    return;
                  }
                  const normalized = normalizeBtcInput(event.target.value);
                  if (normalized !== null) setBitcoinAmountInputs((current) => ({ ...current, [tradeRole]: normalized }));
                }}
                aria-describedby={`trade-rounding premium-note${bitcoinAmountError ? " bitcoin-amount-error" : ""}`}
                aria-invalid={Boolean(bitcoinAmountError) || undefined}
              />
              <span className="amount-unit-control">
                <select
                  className="amount-unit-select"
                  value={amountInputUnit}
                  onChange={(event) => changeAmountInputUnit(event.target.value as AmountInputUnit)}
                  aria-label="거래 금액 입력 단위"
                  title="원·sats·BTC 단위 변경"
                >
                  <option value="krw">원</option>
                  <option value="sats">sats</option>
                  <option value="btc">BTC</option>
                </select>
                <span className="amount-unit-chevron" aria-hidden="true">▼</span>
              </span>
            </span>
          </div>

          <label className="field" htmlFor="seller-premium">
            <span>판매자 프리미엄 (%)</span>
            <span className="input-with-unit">
              <input
                id="seller-premium"
                inputMode="decimal"
                value={premiumInput}
                onChange={(event) => setPremiumInput(signedDecimalOnly(event.target.value, 2))}
                aria-describedby={`premium-note${premiumError ? " premium-error" : ""}${premiumWarning ? " premium-warning" : ""}`}
                aria-invalid={Boolean(premiumError) || undefined}
              />
              <span className="premium-stepper" role="group" aria-label="판매자 프리미엄 0.1% 단위 조절">
                <b aria-hidden="true">%</b>
                <button
                  type="button"
                  onClick={() => adjustPremium(1)}
                  aria-label="판매자 프리미엄 0.1% 올리기"
                  title="0.1% 올리기"
                >
                  <span aria-hidden="true">▲</span>
                </button>
                <button
                  type="button"
                  onClick={() => adjustPremium(-1)}
                  disabled={premiumPercent !== null && premiumPercent <= -99.99}
                  aria-label="판매자 프리미엄 0.1% 내리기"
                  title="0.1% 내리기"
                >
                  <span aria-hidden="true">▼</span>
                </button>
              </span>
            </span>
          </label>
          <p className="premium-note" id="premium-note">{premiumSummary}</p>
          {premiumError ? <p className="input-alert" id="premium-error" role="alert">{premiumError}</p> : null}
          {premiumWarning ? <p className="input-alert" id="premium-warning" role="status">기준 시세와 10% 이상 차이 납니다. 입력값을 다시 확인하세요.</p> : null}
          {bitcoinAmountError ? <p className="input-alert" id="bitcoin-amount-error" role="alert">{bitcoinAmountError}</p> : null}
          <label className="fund-source-field" htmlFor="buyer-funding-source">
            <span>{fundingSourceFieldLabel}<small>선택 사항</small></span>
            <select
              id="buyer-funding-source"
              value={fundingSource}
              onChange={(event) => setFundingSources((current) => ({
                ...current,
                [tradeRole]: event.target.value as FundingSource,
              }))}
              aria-describedby="fund-source-note"
            >
              {FUNDING_SOURCE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <p className="fund-source-note" id="fund-source-note">자금 출처는 구매자가 제공하는 정보입니다. 거래 전에 서로 확인해 주세요.</p>
        </form>

        <section className="trade-result" aria-labelledby="result-title">
          <header className="result-head">
            <h2 id="result-title">거래 조건</h2>
            <label className="result-unit-select">
              <span className="visually-hidden">비트코인 표시 단위</span>
              <select
                value={bitcoinDisplayUnit}
                onChange={(event) => changeBitcoinDisplayUnit(event.target.value as BitcoinDisplayUnit)}
                aria-label="비트코인 표시 단위"
              >
                <option value="sats">sats로 보기</option>
                <option value="btc">BTC로 보기</option>
              </select>
            </label>
          </header>
          {quote && multiplier !== null ? (
            <>
              <output className="visually-hidden" aria-live="polite" aria-atomic="true">
                {resultAnnouncement || currentResultAnnouncement}
              </output>
              <dl>
                <div className={`result-row transfer-row ${tradeRole === "seller" ? "primary" : ""}`}>
                  <dt>구매자 → 판매자{tradeRole === "seller" ? <small className="result-badge">내가 받음</small> : null}</dt>
                  <dd>{formatKrw(quote.paymentKrw)}<small className="result-spacer" aria-hidden="true">&nbsp;</small></dd>
                </div>
                <div className={`result-row transfer-row ${tradeRole === "buyer" ? "primary" : ""}`}>
                  <dt>판매자 → 구매자{tradeRole === "buyer" ? <small className="result-badge">내가 받음</small> : null}</dt>
                  <dd>
                    {bitcoinDisplayUnit === "btc" ? formatBtc(quote.sats) : formatSats(quote.sats)}
                    <small>{bitcoinDisplayUnit === "btc" ? formatSats(quote.sats) : formatBtc(quote.sats)}</small>
                  </dd>
                </div>
                <div className="result-row">
                  <dt>판매자가 파는 BTC 가격</dt>
                  <dd>{formatKrw(quote.appliedPrice)}<small>{referenceLabel} {formatKrw(referencePrice)} × {multiplier.toLocaleString("ko-KR", { maximumFractionDigits: 4 })}</small></dd>
                </div>
              </dl>
            </>
          ) : <p className="result-empty" role="status">{resultUnavailable}</p>}
        </section>

        <div className="capture-meta" id="trade-rounding" role="note" aria-label="거래 계산 참고사항">
          <span className="capture-meta-fee" aria-label="온체인 수수료: 판매자 부담, 구매자 수령량 차감 없음"><b>온체인 수수료:</b><span>판매자 부담 · 구매자 수령량 차감 없음</span></span>
          <span className="capture-meta-rounding" aria-label="반올림: 1 sat, 1원"><b>반올림:</b><span>1 sat·1원</span></span>
          <span className="capture-meta-disclaimer" aria-label="확인용: 원화 입금과 비트코인 수령 증빙 아님"><b>확인용:</b><span>원화 입금·BTC 수령 증빙 아님</span></span>
        </div>
      </article>

      <div className="tool-actions">
        <button
          className={`share-button ${backgroundShareImagePreparing ? "is-background-preparing" : ""}`}
          type="button"
          onClick={() => void shareTrade()}
          disabled={!shareImageAllowed || isSharing || (shareImagePreparing && !shareImageFailed)}
          aria-busy={isSharing || shareImagePreparing}
        >
          {isSharing
            ? "거래 조건 공유 중"
            : shareImageFailed
              ? "거래 조건 다시 준비"
              : shareImagePreparing && !backgroundShareImagePreparing
                ? "거래 조건 준비 중"
                : stalePrice
                  ? "시세 새로고침 후 공유"
                  : "거래 조건 공유"}
        </button>
        <p
          className={`share-status ${shareStatusIsError ? "is-error" : shareStatus ? "is-feedback" : "is-idle"}`}
          aria-live="polite"
          role={shareStatusIsError ? "alert" : undefined}
        >
          {shareStatus || (!isSharing && (!shareImagePreparing || backgroundShareImagePreparing) ? "입력값은 이 브라우저에 최대 12시간 임시 저장되며 서버에는 저장되지 않습니다." : "")}
        </p>
      </div>

      <section className={`network-fees is-${feeVisualState}`} aria-labelledby="network-fees-title">
        <header>
          <h2 id="network-fees-title">현재 온체인 수수료율<small>· 참고용</small></h2>
          <div className="network-fees-status">
            <span>mempool.space</span>
            <p>{feeStatus}</p>
          </div>
        </header>
        <dl aria-label="mempool.space 권장 온체인 수수료율">
          <div>
            <dt>다음 블록</dt>
            <dd><strong>{formatFeeRate(feeRates?.nextBlock)}</strong><small>sat/vB</small></dd>
          </div>
          <div>
            <dt>약 30분</dt>
            <dd><strong>{formatFeeRate(feeRates?.halfHour)}</strong><small>sat/vB</small></dd>
          </div>
          <div>
            <dt>약 1시간</dt>
            <dd><strong>{formatFeeRate(feeRates?.hour)}</strong><small>sat/vB</small></dd>
          </div>
        </dl>
        <p className="network-fees-note"><b>판매자 부담</b><span>실제 총 수수료는 보내는 지갑에서 확인</span></p>
      </section>

      {marketError ? <p className="market-error" role="alert">{marketError}</p> : null}

      <TradeRecruitmentTool
        tradeRole={tradeRole}
        amountUnit={amountInputUnit}
        amountInput={amountBasis === "krw" ? krwAmount : bitcoinAmountInput}
        sellerPremiumInput={premiumInput}
      />
    </section>
  );
}
