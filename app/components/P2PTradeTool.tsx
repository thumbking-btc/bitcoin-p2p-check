"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  calculateP2PQuote,
  MAX_PREMIUM_PERCENT,
  SATS_PER_BTC,
  stepPremiumPercent,
} from "../lib/p2p-quote.mjs";
import { groupedBtcInput, normalizeBtcInput, parseBitcoinAmount, satsToBtcInput } from "../lib/bitcoin-amount.mjs";
import { isReferenceShareable, shareImageFile } from "../lib/share-transport.mjs";
import { buildTradeIntent } from "../lib/trade-share-copy.mjs";
import { parseTradeFragment } from "../lib/trade-link.mjs";
import {
  readTradeDraft,
  removeTradeDraft,
  TRADE_DRAFT_STORAGE_KEY,
  writeTradeDraft,
} from "../lib/trade-draft.mjs";
import { getMarketRefreshDelay, getMarketRefreshInterval } from "../lib/market-refresh.mjs";
import {
  isLiveStreamStalled,
  LIVE_STREAM_STALL_TIMEOUT_MS,
  markMarketPriceStale,
  mergeLiveMarketSnapshot,
  mergeRestMarketSnapshot,
} from "../lib/market-freshness.mjs";
import { runWithAbortTimeout } from "../lib/operation-timeout.mjs";
import {
  createPendingTradeRecord,
  createTradeRecordRevokeToken,
  fetchTradeRecord,
  finalizeTradeRecord,
  isTerminalTradeRecordRevocationError,
  revokeTradeRecord,
  TradeRecordApiRequestError,
} from "../lib/trade-record-client";
import { deriveAppliedPriceKrw } from "../lib/trade-record";
import {
  cacheAttemptFile,
  cacheAttemptRecord,
  createLargeTradeConfirmationKey,
  createPreparedTradeShare,
  createShareAttempt,
  isTradeShareTransitionSafe,
  LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY,
  loadPersistedManagedTradeRecords,
  MANAGED_TRADE_RECORD_STORAGE_PREFIX,
  managedTradeRecordCleanupAt,
  matchingShareAttempt,
  parseManagedTradeRecordStorageKey,
  parsePersistedManagedTradeRecord,
  parsePersistedManagedTradeRecords,
  persistManagedTradeRecord,
  pruneExpiredManagedTradeRecords,
  recordShareDelivery,
  removeManagedTradeRecord,
  removePersistedManagedTradeRecord,
  serializeManagedTradeRecords,
  tradeRecordPaymentExpiresAt,
  toManagedTradeRecord,
  upsertManagedTradeRecord,
  type ManagedTradeRecord,
  type PreparedTradeShare,
  type ShareAttemptCache,
} from "../lib/trade-share-session";
import { TradeRecruitmentTool } from "./TradeRecruitmentTool";
import {
  TradeReceiveInfoPortal,
  type ReceiveInfoLifecycleState,
  type VerifiedReceiveInfo,
} from "./TradeReceiveInfoPortal";

type TradeRole = "buyer" | "seller";
type FocusedField = "krw" | "bitcoin" | null;
type BitcoinDisplayUnit = "btc" | "sats";
type AmountBasis = "krw" | "bitcoin";
type AmountInputUnit = "krw" | BitcoinDisplayUnit;
type OutputMode = "recruitment" | "trade-image";
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
const MAX_LIVE_PRICE_AGE_MS = 2 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;
const MARKET_REQUEST_TIMEOUT_MS = 12_000;
const TRADE_RECORD_CREATE_TIMEOUT_MS = 15_000;
const FINALIZATION_RECONCILE_RETRY_MS = 5 * 60_000;
const FINALIZATION_RECONCILE_MAX_CONCURRENCY = 4;
const FINALIZATION_RECONCILE_START_INTERVAL_MS = 600;
const MANAGED_RECORD_EXPIRY_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Seoul",
});

function formatManagedRecordExpiry(expiresAt: string): string {
  return MANAGED_RECORD_EXPIRY_FORMATTER.format(new Date(expiresAt));
}

function managedTradeRecordDisplayDeadline(record: ManagedTradeRecord): string {
  return record.lifecycle === "finalizing"
    ? new Date(managedTradeRecordCleanupAt(record)).toISOString()
    : record.expiresAt;
}

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
  fundingSource: FundingSource;
  bitcoinDisplayUnit: BitcoinDisplayUnit;
};

const DEFAULT_TRADE_DRAFT: TradeDraftFields = {
  tradeRole: "buyer",
  krwAmounts: { buyer: "3000000", seller: "3000000" },
  bitcoinAmountInputs: { buyer: "3000000", seller: "3000000" },
  amountBasisByRole: { buyer: "krw", seller: "bitcoin" },
  premiumInput: "0",
  fundingSource: "기재하지 않음",
  bitcoinDisplayUnit: "sats",
};

function freshDefaultTradeDraft(): TradeDraftFields {
  return {
    ...DEFAULT_TRADE_DRAFT,
    krwAmounts: { ...DEFAULT_TRADE_DRAFT.krwAmounts },
    bitcoinAmountInputs: { ...DEFAULT_TRADE_DRAFT.bitcoinAmountInputs },
    amountBasisByRole: { ...DEFAULT_TRADE_DRAFT.amountBasisByRole },
  };
}

function fieldsFromStoredTradeDraft(stored: ReturnType<typeof readTradeDraft>): TradeDraftFields {
  if (!stored) return freshDefaultTradeDraft();
  return {
    tradeRole: stored.tradeRole as TradeRole,
    krwAmounts: { ...stored.krwAmounts },
    bitcoinAmountInputs: { ...stored.bitcoinAmountInputs },
    amountBasisByRole: { ...stored.amountBasisByRole },
    premiumInput: stored.premiumInput,
    fundingSource: DEFAULT_TRADE_DRAFT.fundingSource,
    bitcoinDisplayUnit: stored.bitcoinDisplayUnit as BitcoinDisplayUnit,
  };
}

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
  return runWithAbortTimeout(async (signal: AbortSignal) => {
    const response = await fetch(`/api/market?price=${includePrice ? "1" : "0"}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error("market request failed");
    const data = await response.json() as MarketSnapshot;
    if (includePrice && (!Number.isFinite(data.priceKrw) || Number(data.priceKrw) <= 0)) {
      throw new Error("price unavailable");
    }
    return data;
  }, MARKET_REQUEST_TIMEOUT_MS, "시세 조회 시간이 초과되었습니다.");
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
  const trade = value as {
    code?: unknown;
    cd?: unknown;
    mk?: unknown;
    trade_price?: unknown;
    tp?: unknown;
    trade_timestamp?: unknown;
    ttms?: unknown;
  };
  const code = trade.code ?? trade.cd ?? trade.mk;
  if (code !== "KRW-BTC") return null;

  const priceKrw = Number(trade.trade_price ?? trade.tp);
  const observedAtMs = Number(trade.trade_timestamp ?? trade.ttms);
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

function formatKrw(value: number | string | null | undefined) {
  if (typeof value === "string") {
    if (!/^(?:0|[1-9]\d*)$/u.test(value)) return "—";
    return `${BigInt(value).toLocaleString("ko-KR")}원`;
  }
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

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const tick = () => {
      clearTimer();
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      setCurrentTime(new Date(now).toISOString());
      timer = window.setTimeout(tick, 1_000 - (now % 1_000));
    };

    const handleVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState === "visible") tick();
    };

    if (document.visibilityState === "visible") tick();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return (
    <span title={active ? `최근 체결: ${formatTime(tradeObservedAt)}` : undefined}>
      {active ? "실시간" : "연결 중"} · {formatTime(currentTime ?? tradeObservedAt)}
    </span>
  );
}

type ReconciliationPermit = () => void;
type ReconciliationScheduler = Readonly<{
  acquire: (signal: AbortSignal) => Promise<ReconciliationPermit>;
}>;

function createReconciliationScheduler(): ReconciliationScheduler {
  type Waiter = {
    signal: AbortSignal;
    resolve: (release: ReconciliationPermit) => void;
    reject: (reason: unknown) => void;
    onAbort: () => void;
  };

  const queue = new Set<Waiter>();
  let active = 0;
  let lastStartedAt = 0;
  let startTimer: number | null = null;

  const pump = () => {
    if (startTimer !== null || active >= FINALIZATION_RECONCILE_MAX_CONCURRENCY) return;
    const waiter = queue.values().next().value as Waiter | undefined;
    if (!waiter) return;
    if (waiter.signal.aborted) {
      waiter.onAbort();
      return;
    }
    const delay = Math.max(
      0,
      lastStartedAt + FINALIZATION_RECONCILE_START_INTERVAL_MS - Date.now(),
    );
    if (delay > 0) {
      startTimer = window.setTimeout(() => {
        startTimer = null;
        pump();
      }, delay);
      return;
    }

    queue.delete(waiter);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    active += 1;
    lastStartedAt = Date.now();
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      active -= 1;
      pump();
    });
    pump();
  };

  return Object.freeze({
    acquire(signal) {
      if (signal.aborted) {
        return Promise.reject(signal.reason ?? new DOMException("Reconciliation aborted.", "AbortError"));
      }
      return new Promise<ReconciliationPermit>((resolve, reject) => {
        const waiter = {} as Waiter;
        waiter.signal = signal;
        waiter.resolve = resolve;
        waiter.reject = reject;
        waiter.onAbort = () => {
          if (!queue.delete(waiter)) return;
          signal.removeEventListener("abort", waiter.onAbort);
          reject(signal.reason ?? new DOMException("Reconciliation aborted.", "AbortError"));
          pump();
        };
        queue.add(waiter);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        pump();
      });
    },
  });
}

function FinalizingTradeRecordReconciler({
  record,
  acquirePermit,
  readStorageGeneration,
  onFinalized,
  onInvalidCapability,
  onMissing,
}: {
  record: ManagedTradeRecord;
  acquirePermit: (signal: AbortSignal) => Promise<ReconciliationPermit>;
  readStorageGeneration: () => number;
  onFinalized: (record: ManagedTradeRecord, storageGeneration: number) => void;
  onInvalidCapability: (record: ManagedTradeRecord) => void;
  onMissing: (record: ManagedTradeRecord) => boolean;
}) {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const storageGeneration = readStorageGeneration();
    let retryTimer: number | null = null;
    const scheduleRetry = () => {
      const remainingRecoveryMs = managedTradeRecordCleanupAt(record) - Date.now();
      if (remainingRecoveryMs <= 0) return;
      retryTimer = window.setTimeout(
        () => setRevision((current) => current + 1),
        Math.min(FINALIZATION_RECONCILE_RETRY_MS, remainingRecoveryMs),
      );
    };

    void (async () => {
      let releasePermit: ReconciliationPermit | null = null;
      try {
        releasePermit = await acquirePermit(controller.signal);
        const signed = record.persistence === "browser"
          ? await finalizeTradeRecord(record.id, record.revokeToken, {
              signal: controller.signal,
              timeoutMs: TRADE_RECORD_CREATE_TIMEOUT_MS,
            })
          : await fetchTradeRecord(record.id, {
              signal: controller.signal,
              timeoutMs: TRADE_RECORD_CREATE_TIMEOUT_MS,
            });
        if (controller.signal.aborted) return;
        onFinalized(
          toManagedTradeRecord(signed, record.revokeToken, "finalized"),
          storageGeneration,
        );
      } catch (reason) {
        if (controller.signal.aborted) return;
        const invalidCapability = reason instanceof TradeRecordApiRequestError
          && reason.code === "INVALID_CAPABILITY"
          && (reason.status === 401 || reason.status === 403);
        if (invalidCapability) {
          onInvalidCapability(record);
          return;
        }
        const confirmedMissing = reason instanceof TradeRecordApiRequestError
          && reason.code === "RECORD_NOT_FOUND"
          && reason.status === 404;
        if (confirmedMissing
          && (record.persistence === "browser"
            || managedTradeRecordCleanupAt(record) <= Date.now())) {
          if (!onMissing(record)) scheduleRetry();
        } else {
          scheduleRetry();
        }
      } finally {
        releasePermit?.();
      }
    })();

    return () => {
      controller.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [acquirePermit, onFinalized, onInvalidCapability, onMissing, readStorageGeneration, record, revision]);

  return null;
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
  document.body.appendChild(link);
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
  const [fundingSource, setFundingSource] = useState<FundingSource>(DEFAULT_TRADE_DRAFT.fundingSource);
  const [importedTradeLink, setImportedTradeLink] = useState(false);
  const [bitcoinDisplayUnit, setBitcoinDisplayUnit] = useState<BitcoinDisplayUnit>(DEFAULT_TRADE_DRAFT.bitcoinDisplayUnit);
  const [outputMode, setOutputMode] = useState<OutputMode>("recruitment");
  const [draftHydrated, setDraftHydrated] = useState(false);
  const skipNextDraftPersistence = useRef(true);
  const [focusedField, setFocusedField] = useState<FocusedField>(null);
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [marketState, setMarketState] = useState<"loading" | "ready" | "error">("loading");
  const [marketError, setMarketError] = useState("");
  const [priceExpired, setPriceExpired] = useState(false);
  const [livePriceActive, setLivePriceActive] = useState(false);
  const [resultLiveMode, setResultLiveMode] = useState<"off" | "polite">("polite");
  const [shareStatus, setShareStatus] = useState("");
  const [preparedTradeShare, setPreparedTradeShare] = useState<PreparedTradeShare | null>(null);
  const [managedTradeRecords, setManagedTradeRecords] = useState<ManagedTradeRecord[]>([]);
  const [managedTradeRecordsHydrated, setManagedTradeRecordsHydrated] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [confirmedLargeTradeKey, setConfirmedLargeTradeKey] = useState("");
  const [draftStatus, setDraftStatus] = useState("");
  const [draftSyncRevision, setDraftSyncRevision] = useState(0);
  const [receiveInfoLifecycleStatus, setReceiveInfoLifecycleStatus] = useState<ReceiveInfoLifecycleState["status"]>("empty");
  const [verifiedReceiveInfo, setVerifiedReceiveInfo] = useState<VerifiedReceiveInfo | null>(null);
  const marketRef = useRef<MarketSnapshot | null>(null);
  const marketRequestRef = useRef<ActiveMarketRefresh | null>(null);
  const lastMarketRefreshAtRef = useRef(0);
  const attemptedInitialMarketLoadRef = useRef(false);
  const livePriceActiveRef = useRef(false);
  const isSharingRef = useRef(false);
  const paymentLockRef = useRef(false);
  const receiveInfoLifecycleStatusRef = useRef<ReceiveInfoLifecycleState["status"]>("empty");
  const pendingMarketSnapshotRef = useRef<MarketSnapshot | null>(null);
  const shareAttemptCacheRef = useRef<ShareAttemptCache | null>(null);
  const preparedTradeShareRef = useRef<PreparedTradeShare | null>(null);
  const currentShareAttemptKeyRef = useRef("");
  const sharePreparationAllowedRef = useRef(false);
  const autoRevokingRecordIdRef = useRef("");
  const removedManagedRecordIdsRef = useRef(new Set<string>());
  const suppressedManagedRecordIdsRef = useRef(new Set<string>());
  const knownManagedRecordIdsRef = useRef(new Set<string>());
  const knownManagedRecordsRef = useRef(new Map<string, ManagedTradeRecord>());
  const managedStorageGenerationRef = useRef(0);
  const managedTradeRecordsRef = useRef<ManagedTradeRecord[]>([]);
  const reconciliationScheduler = useMemo(() => createReconciliationScheduler(), []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const restored = loadPersistedManagedTradeRecords(
          window.localStorage,
          window.location.origin,
        );
        const accepted: ManagedTradeRecord[] = [];
        const conflictedIds = new Set<string>();
        let capabilityConflict = false;
        for (const record of restored) {
          knownManagedRecordIdsRef.current.add(record.id);
          const known = knownManagedRecordsRef.current.get(record.id);
          if (known && known.revokeToken !== record.revokeToken) {
            capabilityConflict = true;
            conflictedIds.add(record.id);
            suppressedManagedRecordIdsRef.current.add(record.id);
            knownManagedRecordsRef.current.set(
              record.id,
              Object.freeze({ ...known, persistence: "memory-only" as const }),
            );
            try {
              removePersistedManagedTradeRecord(window.localStorage, record.id);
            } catch {
              // The in-memory tombstone still prevents this tab from accepting the conflict.
            }
            continue;
          }
          const preferred = known ? upsertManagedTradeRecord([known], record)[0] : record;
          knownManagedRecordsRef.current.set(record.id, preferred);
          accepted.push(preferred);
        }
        if (capabilityConflict) {
          setShareStatus("오류: 같은 기록에 서로 다른 철회 권한이 저장되어 기존 권한만 이 화면의 메모리에 보존했습니다. 이 화면을 닫기 전에 철회하십시오.");
        }
        setManagedTradeRecords((current) => accepted.reduce(
          (records, record) => upsertManagedTradeRecord(records, record),
          current.map((record) => (
            conflictedIds.has(record.id)
              ? Object.freeze({ ...record, persistence: "memory-only" as const })
              : record
          )),
        ));
      } catch {
        // The record flow remains usable when site storage is unavailable.
      } finally {
        setManagedTradeRecordsHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!managedTradeRecordsHydrated || managedTradeRecords.length === 0) return;
    const now = Date.now();
    const expiryTimes = managedTradeRecords
      .map((record) => managedTradeRecordCleanupAt(record))
      .filter(Number.isFinite);
    const nextExpiry = expiryTimes.length === 0 ? now : Math.min(...expiryTimes);
    const delay = Math.max(0, Math.min(nextExpiry - now, 24 * 60 * 60 * 1_000));
    const timer = window.setTimeout(() => {
      const removalTime = Date.now();
      let browserRemovalFailed = false;
      for (const record of managedTradeRecords) {
        if (managedTradeRecordCleanupAt(record) > removalTime) continue;
        removedManagedRecordIdsRef.current.add(record.id);
        suppressedManagedRecordIdsRef.current.delete(record.id);
        knownManagedRecordsRef.current.delete(record.id);
        try {
          removePersistedManagedTradeRecord(window.localStorage, record.id);
        } catch {
          browserRemovalFailed = true;
        }
      }
      if (browserRemovalFailed) {
        setShareStatus("오류: 만료된 거래 기록의 철회 권한을 브라우저 저장소에서 삭제하지 못했습니다. 브라우저의 사이트 데이터를 직접 삭제하십시오.");
      }
      setManagedTradeRecords((current) => pruneExpiredManagedTradeRecords(current, removalTime));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [managedTradeRecords, managedTradeRecordsHydrated]);

  const finalizingManagedTradeRecords = useMemo(
    () => managedTradeRecords.filter((record) => record.lifecycle === "finalizing"),
    [managedTradeRecords],
  );

  const readManagedStorageGeneration = useCallback(
    () => managedStorageGenerationRef.current,
    [],
  );

  const handleFinalizingRecordFinalized = useCallback((
    finalizedRecord: ManagedTradeRecord,
    reconciliationStorageGeneration: number,
  ) => {
    if (removedManagedRecordIdsRef.current.has(finalizedRecord.id)) {
      knownManagedRecordsRef.current.delete(finalizedRecord.id);
      setManagedTradeRecords((current) => removeManagedTradeRecord(current, finalizedRecord.id));
      return;
    }
    knownManagedRecordIdsRef.current.add(finalizedRecord.id);
    if (reconciliationStorageGeneration !== managedStorageGenerationRef.current
      || suppressedManagedRecordIdsRef.current.has(finalizedRecord.id)) {
      setManagedTradeRecords((current) => upsertManagedTradeRecord(current, finalizedRecord));
      setShareStatus("오류: 공개 확정 상태를 확인했지만 브라우저 데이터가 삭제되어 철회 권한을 다시 저장하지 않았습니다. 이 화면을 닫기 전에 철회하십시오.");
      knownManagedRecordsRef.current.set(finalizedRecord.id, finalizedRecord);
      return;
    }
    let remembered = finalizedRecord;
    try {
      remembered = persistManagedTradeRecord(
        window.localStorage,
        finalizedRecord,
        window.location.origin,
      );
    } catch {
      setShareStatus("오류: 공개 확정 상태를 확인했지만 철회 권한의 브라우저 저장 상태를 갱신하지 못했습니다. 이 화면을 닫기 전에 철회하십시오.");
    }
    knownManagedRecordsRef.current.set(finalizedRecord.id, remembered);
    setManagedTradeRecords((current) => upsertManagedTradeRecord(current, remembered));
  }, []);

  const handleFinalizingRecordMissing = useCallback((record: ManagedTradeRecord) => {
    removedManagedRecordIdsRef.current.add(record.id);
    suppressedManagedRecordIdsRef.current.delete(record.id);
    knownManagedRecordsRef.current.delete(record.id);
    try {
      removePersistedManagedTradeRecord(window.localStorage, record.id);
      setManagedTradeRecords((current) => removeManagedTradeRecord(current, record.id));
      return true;
    } catch {
      setShareStatus("오류: 공개 확정할 수 없는 준비 기록의 철회 권한을 브라우저 저장소에서 삭제하지 못했습니다. 브라우저의 사이트 데이터를 직접 삭제하십시오.");
      return false;
    }
  }, []);

  const handleFinalizingRecordInvalidCapability = useCallback((record: ManagedTradeRecord) => {
    removedManagedRecordIdsRef.current.add(record.id);
    suppressedManagedRecordIdsRef.current.delete(record.id);
    knownManagedRecordsRef.current.delete(record.id);
    let browserRemovalFailed = false;
    try {
      removePersistedManagedTradeRecord(window.localStorage, record.id);
    } catch {
      browserRemovalFailed = true;
    }
    setManagedTradeRecords((current) => removeManagedTradeRecord(current, record.id));
    setShareStatus(browserRemovalFailed
      ? "오류: 유효하지 않은 거래 기록 관리 권한을 브라우저 저장소에서 삭제하지 못했습니다. 브라우저의 사이트 데이터를 직접 삭제하십시오."
      : "오류: 유효하지 않은 거래 기록 관리 권한을 브라우저 저장소에서 제거했습니다.");
  }, []);

  useEffect(() => {
    managedTradeRecordsRef.current = managedTradeRecords;
  }, [managedTradeRecords]);

  useEffect(() => {
    const keepKnownRecordInMemory = (recordId: string) => {
      const known = knownManagedRecordsRef.current.get(recordId);
      if (!known || known.persistence === "memory-only") return;
      knownManagedRecordsRef.current.set(
        recordId,
        Object.freeze({ ...known, persistence: "memory-only" as const }),
      );
    };
    const handleStorage = (event: StorageEvent) => {
      let storage: Storage;
      try {
        storage = window.localStorage;
      } catch {
        return;
      }
      if (event.storageArea && event.storageArea !== storage) return;
      if (event.key === null) {
        managedStorageGenerationRef.current += 1;
        const recordIds = new Set(knownManagedRecordIdsRef.current);
        for (const record of managedTradeRecordsRef.current) recordIds.add(record.id);
        let browserRemovalFailed = false;
        for (const recordId of recordIds) {
          knownManagedRecordIdsRef.current.add(recordId);
          suppressedManagedRecordIdsRef.current.add(recordId);
          keepKnownRecordInMemory(recordId);
          try {
            removePersistedManagedTradeRecord(storage, recordId);
          } catch {
            browserRemovalFailed = true;
          }
        }
        if (browserRemovalFailed) {
          setShareStatus("오류: 삭제 직후 다시 기록된 철회 권한을 정리하지 못했습니다. 이 사이트의 탭을 모두 닫은 뒤 브라우저 사이트 데이터를 직접 삭제하십시오.");
        }
        setManagedTradeRecords((current) => current.map((record) => (
          Object.freeze({ ...record, persistence: "memory-only" as const })
        )));
        return;
      }
      if (event.key === LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY) {
        if (event.newValue === null) {
          setManagedTradeRecords((current) => current.map((record) => {
            if (record.lifecycle !== "finalized") return record;
            try {
              if (storage.getItem(`${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${record.id}`) !== null) {
                return record;
              }
            } catch {
              // Treat an unreadable scoped value as unavailable in this tab.
            }
            keepKnownRecordInMemory(record.id);
            return Object.freeze({ ...record, persistence: "memory-only" as const });
          }));
          return;
        }
        const restored = parsePersistedManagedTradeRecords(
          event.newValue,
          window.location.origin,
        );
        if (restored.length === 0) return;
        const migrated: ManagedTradeRecord[] = [];
        const residualLegacyRecords: ManagedTradeRecord[] = [];
        for (const record of restored) {
          if (removedManagedRecordIdsRef.current.has(record.id)
            || suppressedManagedRecordIdsRef.current.has(record.id)) {
            continue;
          }
          const known = knownManagedRecordsRef.current.get(record.id);
          if (known && known.revokeToken !== record.revokeToken) {
            migrated.push(Object.freeze({ ...known, persistence: "memory-only" as const }));
            residualLegacyRecords.push(record);
            continue;
          }
          try {
            const key = `${MANAGED_TRADE_RECORD_STORAGE_PREFIX}${record.id}`;
            const existing = parsePersistedManagedTradeRecord(
              storage.getItem(key),
              window.location.origin,
            );
            if (existing?.id === record.id && existing.revokeToken !== record.revokeToken) {
              migrated.push(existing);
              residualLegacyRecords.push(record);
              continue;
            }
            const preferred = existing?.id === record.id
              ? upsertManagedTradeRecord([existing], record)[0]
              : record;
            migrated.push(existing && preferred === existing
              ? existing
              : persistManagedTradeRecord(storage, preferred, window.location.origin));
          } catch {
            // Keep the valid capability in memory when migration storage is unavailable.
            migrated.push(record);
            residualLegacyRecords.push(record);
          }
        }
        try {
          if (storage.getItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY) === event.newValue) {
            if (residualLegacyRecords.length === 0) {
              storage.removeItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY);
            } else {
              const residual = serializeManagedTradeRecords(residualLegacyRecords);
              if (residual !== event.newValue) {
                storage.setItem(LEGACY_MANAGED_TRADE_RECORD_STORAGE_KEY, residual);
              }
            }
          }
        } catch {
          setShareStatus("오류: 삭제 뒤 다시 기록된 이전 형식의 철회 권한을 정리하지 못했습니다. 이 사이트의 탭을 모두 닫은 뒤 브라우저 사이트 데이터를 직접 삭제하십시오.");
        }
        for (const record of migrated) {
          knownManagedRecordIdsRef.current.add(record.id);
          const known = knownManagedRecordsRef.current.get(record.id);
          knownManagedRecordsRef.current.set(
            record.id,
            known ? upsertManagedTradeRecord([known], record)[0] : record,
          );
        }
        setManagedTradeRecords((current) => migrated.reduce(
          (records, record) => upsertManagedTradeRecord(records, record),
          [...current],
        ));
        return;
      }
      if (!event.key?.startsWith(MANAGED_TRADE_RECORD_STORAGE_PREFIX)) return;
      const recordId = parseManagedTradeRecordStorageKey(event.key);
      if (!recordId) return;
      if (event.newValue === null) {
        if (suppressedManagedRecordIdsRef.current.has(recordId)) {
          keepKnownRecordInMemory(recordId);
          setManagedTradeRecords((current) => current.map((record) => (
            record.id === recordId
              ? Object.freeze({ ...record, persistence: "memory-only" as const })
              : record
          )));
          return;
        }
        removedManagedRecordIdsRef.current.add(recordId);
        knownManagedRecordsRef.current.delete(recordId);
        try {
          if (storage.getItem(event.key) !== null) storage.removeItem(event.key);
        } catch {
          // The in-memory tombstone still prevents this tab from recreating the capability.
        }
        setManagedTradeRecords((current) => current.filter((record) => record.id !== recordId));
        return;
      }
      if (removedManagedRecordIdsRef.current.has(recordId)
        || suppressedManagedRecordIdsRef.current.has(recordId)) {
        try {
          storage.removeItem(event.key);
        } catch {
          // Keep the in-memory tombstone even when browser storage is unavailable.
        }
        return;
      }
      const restored = parsePersistedManagedTradeRecord(
        event.newValue,
        window.location.origin,
      );
      if (!restored || restored.id !== recordId) {
        keepKnownRecordInMemory(recordId);
        setManagedTradeRecords((current) => current.map((record) => (
          record.id === recordId
            ? Object.freeze({ ...record, persistence: "memory-only" as const })
            : record
        )));
        return;
      }
      const known = knownManagedRecordsRef.current.get(recordId);
      if (known && known.revokeToken !== restored.revokeToken) {
        const preserved = Object.freeze({ ...known, persistence: "memory-only" as const });
        suppressedManagedRecordIdsRef.current.add(recordId);
        knownManagedRecordsRef.current.set(recordId, preserved);
        try {
          storage.removeItem(event.key);
        } catch {
          // The in-memory tombstone still prevents this tab from accepting the conflict.
        }
        setManagedTradeRecords((current) => upsertManagedTradeRecord(current, preserved));
        setShareStatus("오류: 같은 기록에 서로 다른 철회 권한이 감지되어 기존 권한만 이 화면의 메모리에 보존했습니다. 이 화면을 닫기 전에 철회하십시오.");
        return;
      }
      knownManagedRecordIdsRef.current.add(recordId);
      const preferred = known ? upsertManagedTradeRecord([known], restored)[0] : restored;
      let reconciled = preferred;
      if (known && preferred !== restored) {
        try {
          reconciled = persistManagedTradeRecord(
            storage,
            preferred,
            window.location.origin,
          );
        } catch {
          reconciled = Object.freeze({ ...preferred, persistence: "memory-only" as const });
          try {
            if (storage.getItem(event.key) === event.newValue) storage.removeItem(event.key);
          } catch {
            // Keep the stronger lifecycle in memory when the stale browser value cannot be repaired.
          }
        }
      }
      knownManagedRecordsRef.current.set(recordId, reconciled);
      setManagedTradeRecords((current) => upsertManagedTradeRecord(current, reconciled));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const replaceDraftFields = useCallback((fields: TradeDraftFields) => {
    setTradeRole(fields.tradeRole);
    setKrwAmounts(fields.krwAmounts);
    setBitcoinAmountInputs(fields.bitcoinAmountInputs);
    setAmountBasisByRole(fields.amountBasisByRole);
    setPremiumInput(fields.premiumInput);
    setFundingSource(fields.fundingSource);
    setBitcoinDisplayUnit(fields.bitcoinDisplayUnit);
  }, []);

  const applyMarketSnapshot = useCallback((data: MarketSnapshot, silent: boolean) => {
    const current = marketRef.current;
    const referenceLocked = Boolean(isSharingRef.current || paymentLockRef.current || preparedTradeShareRef.current);
    const latest = referenceLocked ? pendingMarketSnapshotRef.current ?? current : current;
    const nextData = mergeRestMarketSnapshot(data, latest, livePriceActiveRef.current) as MarketSnapshot;
    if (referenceLocked) {
      pendingMarketSnapshotRef.current = nextData;
      return;
    }
    if (silent) setResultLiveMode("off");
    marketRef.current = nextData;
    setMarket(nextData);
    setMarketState("ready");
    setMarketError("");
    setPriceExpired(false);
  }, []);

  const applyLivePrice = useCallback((price: LivePrice) => {
    const current = marketRef.current;
    const referenceLocked = Boolean(isSharingRef.current || paymentLockRef.current || preparedTradeShareRef.current);
    const latest = referenceLocked ? pendingMarketSnapshotRef.current ?? current : current;
    if (!latest) return false;
    const nextData = mergeLiveMarketSnapshot(latest, price) as MarketSnapshot;
    if (nextData === latest) return true;
    if (referenceLocked) {
      pendingMarketSnapshotRef.current = nextData;
      return true;
    }

    setResultLiveMode("off");
    marketRef.current = nextData;
    setMarket(nextData);
    setMarketState("ready");
    setMarketError("");
    setPriceExpired(false);
    return true;
  }, []);

  const markMarketStale = useCallback((message: string) => {
    const current = marketRef.current;
    const stale = markMarketPriceStale(current);
    if (stale) {
      marketRef.current = stale;
      setMarket(stale);
    }
    setResultLiveMode("off");
    setMarketState("error");
    setPriceExpired(true);
    setMarketError(message);
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
        if (marketRef.current) {
          markMarketStale(refresh.mode === "silent"
            ? "자동 시세 갱신에 실패했습니다. 마지막 조회값은 확인용으로만 표시하며 공유할 수 없습니다."
            : "시세를 새로 불러오지 못했습니다. 마지막 조회값은 확인용으로만 표시하며 공유할 수 없습니다.");
          return;
        }
        setMarketState("error");
        setPriceExpired(true);
        setMarketError("업비트 최근 체결가를 불러오지 못했습니다. 시세 새로고침을 눌러 다시 확인하세요.");
      },
    ).finally(() => {
      lastMarketRefreshAtRef.current = Date.now();
      if (marketRequestRef.current === refresh) marketRequestRef.current = null;
    });
    marketRequestRef.current = refresh;
    return refresh.promise;
  }, [applyMarketSnapshot, markMarketStale]);

  const loadMarket = useCallback(async () => {
    if (paymentLockRef.current || preparedTradeShareRef.current) return;
    await refreshMarket("manual");
  }, [refreshMarket]);

  const handleVerifiedReceiveInfo = useCallback((info: VerifiedReceiveInfo | null) => {
    setVerifiedReceiveInfo(info);
    if (!info) return;
    paymentLockRef.current = true;
  }, []);

  const handleReceiveInfoLifecycle = useCallback((state: ReceiveInfoLifecycleState) => {
    receiveInfoLifecycleStatusRef.current = state.status;
    setReceiveInfoLifecycleStatus((current) => current === state.status ? current : state.status);
    if (state.status !== "empty") {
      paymentLockRef.current = true;
      return;
    }
    const wasLocked = paymentLockRef.current;
    paymentLockRef.current = false;
    setVerifiedReceiveInfo(null);
    if (!wasLocked) return;
    const pendingSnapshot = pendingMarketSnapshotRef.current;
    if (!pendingSnapshot) return;
    pendingMarketSnapshotRef.current = null;
    applyMarketSnapshot(pendingSnapshot, true);
  }, [applyMarketSnapshot]);

  const marketRefreshIntervalMs = getMarketRefreshInterval(livePriceActive);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const getRefreshDelay = () => getMarketRefreshDelay(
      lastMarketRefreshAtRef.current,
      marketRefreshIntervalMs,
    );

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
    let watchdogTimer: number | null = null;
    let lastMessageAt = 0;
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

    const clearWatchdogTimer = () => {
      if (watchdogTimer === null) return;
      window.clearTimeout(watchdogTimer);
      watchdogTimer = null;
    };

    const browserIsActive = () => document.visibilityState === "visible" && navigator.onLine !== false;

    const disconnect = () => {
      clearReconnectTimer();
      clearRenderTimer();
      clearWatchdogTimer();
      queuedPrice = null;
      lastMessageAt = 0;
      setStreamActive(false);
      const activeSocket = socket;
      socket = null;
      activeSocket?.close();
    };

    const flushQueuedPrice = () => {
      clearRenderTimer();
      const price = queuedPrice;
      queuedPrice = null;
      if (!price || disposed || !browserIsActive()) return;
      lastRenderedAt = Date.now();
      if (applyLivePrice(price)) setStreamActive(true);
    };

    const queuePrice = (price: LivePrice) => {
      if (!browserIsActive()) return;
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
      if (disposed || !browserIsActive()) return;
      reconnectTimer = window.setTimeout(connect, LIVE_PRICE_RECONNECT_DELAY_MS);
    };

    const armWatchdog = (activeSocket: WebSocket) => {
      clearWatchdogTimer();
      watchdogTimer = window.setTimeout(() => {
        watchdogTimer = null;
        if (disposed || socket !== activeSocket || !browserIsActive()) return;
        if (!isLiveStreamStalled(lastMessageAt)) {
          armWatchdog(activeSocket);
          return;
        }
        markMarketStale("실시간 시세 수신이 중단되었습니다. 최신 시세를 다시 확인하고 있습니다.");
        setStreamActive(false);
        activeSocket.close();
        const activeRefresh = marketRequestRef.current?.promise;
        void (async () => {
          if (activeRefresh) await activeRefresh;
          if (disposed || !browserIsActive()) return;
          await refreshMarket("manual");
        })();
      }, LIVE_STREAM_STALL_TIMEOUT_MS);
    };

    const connect = () => {
      if (disposed || !browserIsActive() || socket) return;
      clearReconnectTimer();
      const nextSocket = new WebSocket(UPBIT_TICKER_WEBSOCKET_URL);
      nextSocket.binaryType = "arraybuffer";
      socket = nextSocket;

      nextSocket.onopen = () => {
        if (disposed || socket !== nextSocket || !browserIsActive()) return;
        lastMessageAt = Date.now();
        armWatchdog(nextSocket);
        nextSocket.send(JSON.stringify([
          { ticket: `bitcoin-p2p-check-${Date.now()}` },
          { type: "trade", codes: ["KRW-BTC"], is_only_realtime: true },
          { format: "SIMPLE" },
        ]));
      };

      nextSocket.onmessage = (event) => {
        void parseUpbitTickerMessage(event.data).then((price) => {
          if (!price || disposed || socket !== nextSocket || !browserIsActive()) return;
          lastMessageAt = Date.now();
          armWatchdog(nextSocket);
          queuePrice(price);
        });
      };

      nextSocket.onerror = () => {
        if (socket === nextSocket) nextSocket.close();
      };

      nextSocket.onclose = () => {
        if (socket !== nextSocket) return;
        clearWatchdogTimer();
        lastMessageAt = 0;
        socket = null;
        setStreamActive(false);
        scheduleReconnect();
      };
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        disconnect();
        return;
      }
      connect();
    };

    const handleOnline = () => {
      if (document.visibilityState !== "visible") return;
      connect();
    };

    const handleOffline = () => {
      disconnect();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    if (browserIsActive()) connect();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      disconnect();
    };
  }, [applyLivePrice, markMarketStale, refreshMarket]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const imported = parseTradeFragment(window.location.hash);
      const storage = getTradeDraftStorage();
      const stored = readTradeDraft(storage);
      const hydratedDraft = fieldsFromStoredTradeDraft(stored);

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
        hydratedDraft.fundingSource = imported.fundingSource as FundingSource;
        hydratedDraft.bitcoinDisplayUnit = importedDisplayUnit;
        setImportedTradeLink(true);
        writeTradeDraft(storage, hydratedDraft);
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      }

      replaceDraftFields(hydratedDraft);
      setDraftHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [replaceDraftFields]);

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
      bitcoinDisplayUnit,
    });
  }, [amountBasisByRole, bitcoinAmountInputs, bitcoinDisplayUnit, draftHydrated, draftSyncRevision, krwAmounts, premiumInput, tradeRole]);

  useEffect(() => {
    if (!draftHydrated) return;
    const storage = getTradeDraftStorage();
    if (!storage) return;

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== storage || event.key !== TRADE_DRAFT_STORAGE_KEY) return;
      skipNextDraftPersistence.current = true;
      replaceDraftFields(fieldsFromStoredTradeDraft(readTradeDraft(storage)));
      setDraftSyncRevision((current) => current + 1);
      setDraftStatus(event.newValue === null
        ? "다른 탭에서 저장된 초안을 삭제하여 기본값으로 되돌렸습니다."
        : "다른 탭에서 변경한 초안을 반영했습니다.");
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [draftHydrated, replaceDraftFields]);

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
      : premiumPercent > MAX_PREMIUM_PERCENT
        ? `판매자 프리미엄은 ${MAX_PREMIUM_PERCENT}% 이하로 입력하세요.`
      : "";
  const premiumWarning = premiumPercent !== null
    && premiumPercent > -100
    && premiumPercent <= MAX_PREMIUM_PERCENT
    && Math.abs(premiumPercent) >= 10;
  const referencePrice = market?.priceKrw ?? null;
  const referenceLabel = "업비트 최근 체결가";
  const referenceTime = market?.priceObservedAt ?? null;
  const fundingSourceFieldLabel = tradeRole === "buyer"
    ? "내 구매 자금 출처"
    : "구매자가 제공한 자금 출처";
  const fundingSourceNote = tradeRole === "buyer"
    ? "거래 기록 카드에만 포함됩니다."
    : "구매자가 알려준 내용만 선택해 주세요.";
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
  const largeTradeKey = quote ? createLargeTradeConfirmationKey({
    role: tradeRole,
    amountBasis,
    paymentKrw: quote.paymentKrw,
    sats: quote.sats,
  }) : "";
  const largeTradeConfirmed = !largeTradeKey || confirmedLargeTradeKey === largeTradeKey;
  const tinyTradeWarning = quote && quote.sats <= 1_000
    ? quote.sats === 1
      ? "1 sat은 Lightning에서 전송 가능한 단위이지만, 온체인에서는 dust 기준에 미달할 수 있고 네트워크 수수료가 거래액을 넘을 수 있습니다. 결제 방식을 확인하세요."
      : `${formatSats(quote.sats)}의 극소액 거래입니다. Lightning을 고려할 수 있지만, 온체인에서는 dust 기준에 미달하거나 네트워크 수수료가 거래액을 넘을 수 있습니다.`
    : "";

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
    if (resultLiveMode !== "off") return;
    const frame = window.requestAnimationFrame(() => setResultLiveMode("polite"));
    return () => window.cancelAnimationFrame(frame);
  }, [currentResultAnnouncement, resultLiveMode]);

  const tradeIntent = quote ? buildTradeIntent({
    tradeRole,
    amountBasis,
    paymentKrw: quote.paymentKrw,
    sats: quote.sats,
    bitcoinDisplayUnit,
  }) : "";
  // A payment request is bound to its receiver role and exact BTC amount.
  // Live market timestamps and non-payment annotations must not invalidate it
  // while those two facts remain unchanged.
  const receiveConditionKey = JSON.stringify({ tradeRole, sats: quote?.sats ?? null });
  const paymentForRecord = verifiedReceiveInfo && quote && verifiedReceiveInfo.amountSats === quote.sats
    ? {
        rail: verifiedReceiveInfo.rail,
        payload: verifiedReceiveInfo.payload,
        address: verifiedReceiveInfo.address,
        expiresAt: verifiedReceiveInfo.expiresAt,
      }
    : null;
  const paymentLifecycleBlocksShare = receiveInfoLifecycleStatus === "stale"
    || receiveInfoLifecycleStatus === "expiring"
    || receiveInfoLifecycleStatus === "expired";
  const paymentReferenceLocked = receiveInfoLifecycleStatus !== "empty";
  const marketReferenceLocked = paymentReferenceLocked || Boolean(preparedTradeShare);
  const tradeRecordDraft = quote && referencePrice !== null && referenceTime !== null && premiumPercent !== null
    ? {
        condition: {
          role: tradeRole,
          amountBasis,
          bitcoinDisplayUnit,
          paymentKrw: quote.paymentKrw,
          sats: quote.sats,
          referencePriceKrw: referencePrice,
          marketObservedAt: new Date(referenceTime).toISOString(),
          koreaPremiumRatio: effectiveKoreaPremium,
          sellerPremiumBps: Math.round(premiumPercent * 100),
          fundingSource: fundingSource === "기재하지 않음" ? null : fundingSource,
        },
        payment: paymentForRecord
          ? paymentForRecord.rail === "onchain" && paymentForRecord.address
            ? { rail: "onchain" as const, payload: paymentForRecord.payload, address: paymentForRecord.address }
            : paymentForRecord.rail === "lightning"
              ? paymentForRecord.address
                ? { rail: "lightning" as const, payload: paymentForRecord.payload, address: paymentForRecord.address }
                : { rail: "lightning" as const, payload: paymentForRecord.payload }
              : null
          : null,
      } satisfies Parameters<typeof createPendingTradeRecord>[0]
    : null;
  const shareAttemptKey = tradeRecordDraft ? JSON.stringify(tradeRecordDraft) : "";
  const preparedShareIsCurrent = Boolean(preparedTradeShare && preparedTradeShare.key === shareAttemptKey);
  const shareImageAllowed = Boolean(quote)
    && outputMode === "trade-image"
    && referencePrice !== null
    && premiumPercent !== null
    && draftHydrated
    && largeTradeConfirmed
    && !paymentLifecycleBlocksShare
    && !stalePrice
    && marketState === "ready";
  const shareStatusIsError = Boolean(shareStatus)
    && (shareStatus.startsWith("오류:") || shareStatus.includes("못") || shareStatus.includes("다시"));

  useEffect(() => {
    currentShareAttemptKeyRef.current = shareAttemptKey;
  }, [shareAttemptKey]);

  useEffect(() => {
    sharePreparationAllowedRef.current = shareImageAllowed;
  }, [shareImageAllowed]);

  const releasePreparedReference = useCallback(() => {
    if (preparedTradeShareRef.current || paymentLockRef.current || isSharingRef.current) return;
    const pendingSnapshot = pendingMarketSnapshotRef.current;
    if (!pendingSnapshot) return;
    pendingMarketSnapshotRef.current = null;
    applyMarketSnapshot(pendingSnapshot, true);
  }, [applyMarketSnapshot]);

  const rememberManagedRecord = useCallback((
    record: ManagedTradeRecord,
    expectedStorageGeneration = managedStorageGenerationRef.current,
  ): boolean => {
    if (removedManagedRecordIdsRef.current.has(record.id)) {
      knownManagedRecordsRef.current.delete(record.id);
      setManagedTradeRecords((current) => removeManagedTradeRecord(current, record.id));
      return false;
    }
    knownManagedRecordIdsRef.current.add(record.id);
    const known = knownManagedRecordsRef.current.get(record.id);
    if (known && known.revokeToken !== record.revokeToken) {
      const preserved = Object.freeze({ ...known, persistence: "memory-only" as const });
      suppressedManagedRecordIdsRef.current.add(record.id);
      knownManagedRecordsRef.current.set(record.id, preserved);
      setManagedTradeRecords((current) => upsertManagedTradeRecord(current, preserved));
      return false;
    }
    let remembered = record;
    let persisted = false;
    if (expectedStorageGeneration === managedStorageGenerationRef.current
      && !suppressedManagedRecordIdsRef.current.has(record.id)) {
      try {
        remembered = persistManagedTradeRecord(
          window.localStorage,
          record,
          window.location.origin,
        );
        persisted = true;
      } catch {
        // Keep the capability in memory and surface the storage failure to the caller.
      }
    }
    const preferred = known ? upsertManagedTradeRecord([known], remembered)[0] : remembered;
    knownManagedRecordsRef.current.set(record.id, preferred);
    setManagedTradeRecords((current) => upsertManagedTradeRecord(current, preferred));
    return persisted;
  }, []);

  const forgetManagedRecord = useCallback((record: ManagedTradeRecord): boolean => {
    removedManagedRecordIdsRef.current.add(record.id);
    suppressedManagedRecordIdsRef.current.delete(record.id);
    knownManagedRecordsRef.current.delete(record.id);
    let browserRemovalFailed = false;
    try {
      removePersistedManagedTradeRecord(window.localStorage, record.id);
    } catch {
      browserRemovalFailed = true;
    }
    setManagedTradeRecords((current) => removeManagedTradeRecord(current, record.id));
    if (preparedTradeShareRef.current?.signed.id === record.id) {
      preparedTradeShareRef.current = null;
      setPreparedTradeShare(null);
    }
    if (shareAttemptCacheRef.current?.signed?.id === record.id) shareAttemptCacheRef.current = null;
    return browserRemovalFailed;
  }, []);

  const revokeKnownRecord = useCallback(async (record: ManagedTradeRecord, successMessage: string) => {
    const storageGeneration = managedStorageGenerationRef.current;
    try {
      await revokeTradeRecord(record.id, record.revokeToken, { timeoutMs: TRADE_RECORD_CREATE_TIMEOUT_MS });
      const browserRemovalFailed = forgetManagedRecord(record);
      setShareStatus(browserRemovalFailed
        ? `${successMessage} 다만 만료 전 철회 권한을 브라우저 저장소에서 삭제하지 못했습니다.`
        : successMessage);
      return true;
    } catch (reason) {
      if (isTerminalTradeRecordRevocationError(reason)) {
        const browserRemovalFailed = forgetManagedRecord(record);
        const alreadyAbsent = reason instanceof TradeRecordApiRequestError
          && (reason.code === "RECORD_NOT_FOUND" || reason.code === "RECORD_REVOKED");
        const terminalMessage = alreadyAbsent
          ? "거래 기록이 이미 없거나 철회되어 브라우저의 관리 권한을 정리했습니다."
          : "오류: 거래 기록 관리 권한이 더 이상 유효하지 않아 브라우저에서 제거했습니다. 공개 기록이 남아 있다면 이 권한으로는 철회할 수 없습니다.";
        setShareStatus(browserRemovalFailed
          ? `${terminalMessage} 다만 만료 전 철회 권한을 브라우저 저장소에서 삭제하지 못했습니다.`
          : terminalMessage);
        return true;
      }
      rememberManagedRecord(record, storageGeneration);
      setShareStatus(reason instanceof Error
        ? `오류: 거래 기록을 철회하지 못했습니다. ${reason.message}`
        : "오류: 거래 기록을 철회하지 못했습니다. 다시 시도해 주세요.");
      return false;
    } finally {
      releasePreparedReference();
    }
  }, [forgetManagedRecord, releasePreparedReference, rememberManagedRecord]);

  async function prepareTradeShare() {
    if (!shareImageAllowed || !quote || !tradeRecordDraft || !shareAttemptKey || referenceTime === null || isSharing) return;
    if (stalePrice || !isReferenceShareable({ marketState, referenceTime }, Date.now())) {
      setPriceExpired(true);
      setShareStatus("최신 시세를 다시 조회한 뒤 거래 조건을 공유해 주세요.");
      return;
    }

    setShareStatus("");
    isSharingRef.current = true;
    setIsSharing(true);
    let stage: "creating" | "rendering" = "creating";
    let attempt = matchingShareAttempt(shareAttemptCacheRef.current, shareAttemptKey);
    if (!attempt) {
      attempt = createShareAttempt(shareAttemptKey, createTradeRecordRevokeToken());
      shareAttemptCacheRef.current = attempt;
    }

    try {
      const pending = attempt.signed ?? await createPendingTradeRecord(tradeRecordDraft, {
        revokeToken: attempt.revokeToken,
        timeoutMs: TRADE_RECORD_CREATE_TIMEOUT_MS,
      });
      attempt = cacheAttemptRecord(attempt, pending);
      shareAttemptCacheRef.current = attempt;

      stage = "rendering";
      const signedCondition = pending.record.condition;
      const { createTradeShareImage, materializeTradeShareImage } = await import("../lib/trade-share-image");
      const shareFile = attempt.file ?? await materializeTradeShareImage(await createTradeShareImage({
        tradeRole: signedCondition.role,
        amountBasis: signedCondition.amountBasis,
        bitcoinDisplayUnit: signedCondition.bitcoinDisplayUnit,
        referenceLabel,
        referencePriceKrw: signedCondition.referencePriceKrw,
        referenceTime: signedCondition.marketObservedAt,
        koreaPremiumRatio: signedCondition.koreaPremiumRatio,
        sellerPremiumPercent: signedCondition.sellerPremiumBps / 100,
        buyerFundingSource: signedCondition.fundingSource ?? "기재하지 않음",
        paymentKrw: signedCondition.paymentKrw,
        sats: signedCondition.sats,
        btcAmount: signedCondition.sats / SATS_PER_BTC,
        appliedPriceKrw: deriveAppliedPriceKrw(signedCondition),
        payment: pending.record.payment?.rail === "onchain"
          ? pending.record.payment
          : pending.record.payment
            ? {
                rail: "lightning",
                payload: pending.record.payment.payload,
                ...(pending.record.payment.address ? { address: pending.record.payment.address } : {}),
                ...(pending.record.payment.expiresAt ? { expiresAt: Math.floor(Date.parse(pending.record.payment.expiresAt) / 1_000) } : {}),
              }
            : null,
        record: {
          id: pending.id,
          createdAt: pending.record.createdAt,
          verificationUrl: pending.verificationUrl,
        },
      }));
      attempt = cacheAttemptFile(attempt, shareFile);
      shareAttemptCacheRef.current = attempt;

      const preparationStillSafe = isTradeShareTransitionSafe({
        currentAttemptKey: currentShareAttemptKeyRef.current,
        candidateAttemptKey: attempt.key,
        preparationAllowed: sharePreparationAllowedRef.current,
        receiveInfoLifecycleStatus: receiveInfoLifecycleStatusRef.current,
        marketObservedAt: pending.record.condition.marketObservedAt,
        paymentExpiresAt: tradeRecordPaymentExpiresAt(pending),
      });
      if (!preparationStillSafe) throw new Error("준비 중 거래 조건 또는 시세 유효성이 바뀌었습니다.");

      const prepared = createPreparedTradeShare(attempt, pending, shareFile, tradeIntent);
      preparedTradeShareRef.current = prepared;
      setPreparedTradeShare(prepared);
      setShareStatus("비공개 카드 준비를 마쳤습니다. 아래 버튼을 다시 눌러 공유한 뒤 상세 기록을 공개 확정하십시오.");
    } catch (reason) {
      if (stage === "rendering" && attempt.signed) {
        const record = toManagedTradeRecord(attempt.signed, attempt.revokeToken);
        const revoked = await revokeKnownRecord(record, "준비에 실패한 비공개 거래 기록을 폐기했습니다.");
        if (revoked) shareAttemptCacheRef.current = null;
      }
      if (stage !== "rendering" || shareAttemptCacheRef.current) {
        setShareStatus(reason instanceof Error
          ? `오류: ${reason.message} 같은 조건으로 재시도하면 동일한 준비 기록을 확인합니다.`
          : "오류: 거래 기록 카드를 준비하지 못했습니다. 다시 시도해 주세요.");
      }
    } finally {
      isSharingRef.current = false;
      setIsSharing(false);
      releasePreparedReference();
    }
  }

  async function sharePreparedTrade() {
    const prepared = preparedTradeShareRef.current;
    if (!prepared || isSharing || prepared.key !== currentShareAttemptKeyRef.current || !sharePreparationAllowedRef.current) return;
    isSharingRef.current = true;
    setIsSharing(true);
    setShareStatus("");
    let activePrepared = prepared;
    let stage: "sharing" | "finalizing" = prepared.deliveryOutcome ? "finalizing" : "sharing";
    let finalizationStorageGeneration: number | null = null;
    try {
      const sharingStillSafe = isTradeShareTransitionSafe({
        currentAttemptKey: currentShareAttemptKeyRef.current,
        candidateAttemptKey: activePrepared.key,
        preparationAllowed: sharePreparationAllowedRef.current,
        receiveInfoLifecycleStatus: receiveInfoLifecycleStatusRef.current,
        marketObservedAt: activePrepared.signed.record.condition.marketObservedAt,
        paymentExpiresAt: tradeRecordPaymentExpiresAt(activePrepared.signed),
      });
      if (!sharingStillSafe) {
        await revokeKnownRecord(
          toManagedTradeRecord(activePrepared.signed, activePrepared.revokeToken),
          "공유 직전 인보이스가 만료 임박 상태가 되었거나 거래 조건·시세가 바뀌어 비공개 준비 기록을 폐기했습니다.",
        );
        return;
      }

      if (!activePrepared.deliveryOutcome) {
        let verificationUrlDelivery: NonNullable<PreparedTradeShare["verificationUrlDelivery"]> = "unavailable";
        const outcome = await shareImageFile({
          file: activePrepared.file,
          title: activePrepared.title,
          text: activePrepared.text,
          nativeShare: typeof navigator.share === "function" ? navigator.share.bind(navigator) : null,
          nativeCanShare: typeof navigator.canShare === "function" ? navigator.canShare.bind(navigator) : null,
          download: downloadTradeImage,
          verificationUrl: activePrepared.signed.verificationUrl,
          copyVerificationUrl: async (url: string) => {
            if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
            await navigator.clipboard.writeText(url);
          },
          onDownloadFallback: (details: { verificationUrlDelivery: NonNullable<PreparedTradeShare["verificationUrlDelivery"]> }) => {
            verificationUrlDelivery = details.verificationUrlDelivery;
          },
        });
        if (outcome === "cancelled") {
          await revokeKnownRecord(
            toManagedTradeRecord(activePrepared.signed, activePrepared.revokeToken),
            "공유를 취소하여 비공개 준비 기록을 폐기했습니다.",
          );
          return;
        }
        activePrepared = recordShareDelivery(activePrepared, outcome, verificationUrlDelivery);
        preparedTradeShareRef.current = activePrepared;
        setPreparedTradeShare(activePrepared);
        stage = "finalizing";
      }

      const finalizationStillSafe = isTradeShareTransitionSafe({
        currentAttemptKey: currentShareAttemptKeyRef.current,
        candidateAttemptKey: activePrepared.key,
        preparationAllowed: sharePreparationAllowedRef.current,
        receiveInfoLifecycleStatus: receiveInfoLifecycleStatusRef.current,
        marketObservedAt: activePrepared.signed.record.condition.marketObservedAt,
        paymentExpiresAt: tradeRecordPaymentExpiresAt(activePrepared.signed),
      });
      if (!finalizationStillSafe) {
        await revokeKnownRecord(
          toManagedTradeRecord(activePrepared.signed, activePrepared.revokeToken),
          "공유 뒤 조건 또는 시세가 바뀌어 비공개 기록을 폐기했습니다. 전달된 카드의 상세 링크는 열리지 않습니다.",
        );
        return;
      }

      if (activePrepared.signed.lifecycle !== "finalized") {
        const pendingCapabilityPersisted = rememberManagedRecord(
          toManagedTradeRecord(activePrepared.signed, activePrepared.revokeToken, "finalizing"),
        );
        if (!pendingCapabilityPersisted) {
          setShareStatus("오류: 카드가 전달되었지만 철회 권한을 이 브라우저에 저장하지 못해 공개 확정을 시작하지 않았습니다. 사이트 저장을 허용한 뒤 같은 버튼으로 재시도하거나 준비 기록을 철회하십시오.");
          return;
        }
      }
      finalizationStorageGeneration = managedStorageGenerationRef.current;

      const finalized = activePrepared.signed.lifecycle === "finalized"
        ? activePrepared.signed
        : await finalizeTradeRecord(activePrepared.signed.id, activePrepared.revokeToken, {
            timeoutMs: TRADE_RECORD_CREATE_TIMEOUT_MS,
          });
      const finalizedRecord = toManagedTradeRecord(finalized, activePrepared.revokeToken, "finalized");
      if (finalizationStorageGeneration !== managedStorageGenerationRef.current
        || suppressedManagedRecordIdsRef.current.has(finalizedRecord.id)) {
        setManagedTradeRecords((current) => upsertManagedTradeRecord(current, finalizedRecord));
        preparedTradeShareRef.current = null;
        setPreparedTradeShare(null);
        shareAttemptCacheRef.current = null;
        setShareStatus("오류: 상세 기록은 공개 확정했지만 처리 중 브라우저 데이터가 삭제되어 철회 권한을 다시 저장하지 않았습니다. 이 화면을 닫기 전에 철회하십시오.");
        return;
      }
      if (removedManagedRecordIdsRef.current.has(finalizedRecord.id)) {
        knownManagedRecordsRef.current.delete(finalizedRecord.id);
        setManagedTradeRecords((current) => removeManagedTradeRecord(current, finalizedRecord.id));
        preparedTradeShareRef.current = null;
        setPreparedTradeShare(null);
        shareAttemptCacheRef.current = null;
        setShareStatus("오류: 공개 확정 처리 중 다른 탭에서 이 기록의 관리 권한이 삭제되어 다시 저장하지 않았습니다. 전달한 상세 링크의 상태를 확인하십시오.");
        return;
      }
      const finalizationRemainsSafe = isTradeShareTransitionSafe({
        currentAttemptKey: currentShareAttemptKeyRef.current,
        candidateAttemptKey: activePrepared.key,
        preparationAllowed: sharePreparationAllowedRef.current,
        receiveInfoLifecycleStatus: receiveInfoLifecycleStatusRef.current,
        marketObservedAt: finalized.record.condition.marketObservedAt,
        paymentExpiresAt: tradeRecordPaymentExpiresAt(finalized),
      });
      if (!finalizationRemainsSafe) {
        await revokeKnownRecord(finalizedRecord, "공개 확정 직후 조건 또는 시세가 바뀌어 기록을 철회했습니다. 전달된 카드의 상세 링크는 열리지 않습니다.");
        return;
      }

      const capabilityPersisted = rememberManagedRecord(finalizedRecord);
      preparedTradeShareRef.current = null;
      setPreparedTradeShare(null);
      shareAttemptCacheRef.current = null;
      if (!capabilityPersisted) {
        setShareStatus("오류: 상세 기록은 공개 확정했지만 철회 권한을 이 브라우저에 저장하지 못했습니다. 이 화면을 닫지 말고 아래 철회 버튼을 사용하십시오.");
      } else if (activePrepared.deliveryOutcome === "shared") {
        setShareStatus("거래 기록 카드 공유 후 상세 기록을 공개 확정했습니다. 아래에서 공개 기록을 철회할 수 있습니다.");
      } else if (activePrepared.deliveryOutcome === "downloaded") {
        setShareStatus(activePrepared.verificationUrlDelivery === "copied"
          ? "PNG를 저장하고 상세 링크를 복사한 뒤 기록을 공개 확정했습니다. 두 항목을 함께 보내 주세요."
          : "PNG를 저장하고 상세 기록을 공개 확정했습니다. 아래 상세 링크도 함께 보내 주세요.");
      } else {
        setShareStatus(activePrepared.verificationUrlDelivery === "copied"
          ? "공유 창을 열지 못해 PNG와 상세 링크를 준비하고 기록을 공개 확정했습니다."
          : "공유 창을 열지 못해 PNG를 저장하고 상세 기록을 공개 확정했습니다. 아래 링크도 함께 보내 주세요.");
      }
    } catch (reason) {
      if (stage === "sharing") {
        const revoked = await revokeKnownRecord(
          toManagedTradeRecord(activePrepared.signed, activePrepared.revokeToken),
          "공유 실패 후 비공개 준비 기록을 폐기했습니다.",
        );
        if (!revoked) {
          setShareStatus(reason instanceof Error
            ? `오류: 카드를 공유하지 못했고 준비 기록도 자동 폐기하지 못했습니다. ${reason.message}`
            : "오류: 카드를 공유하지 못했고 준비 기록도 자동 폐기하지 못했습니다. 아래 철회 버튼으로 다시 시도해 주세요.");
        }
      } else {
        const uncertainRecord = toManagedTradeRecord(
          activePrepared.signed,
          activePrepared.revokeToken,
          "finalizing",
        );
        if (finalizationStorageGeneration !== null
          && (finalizationStorageGeneration !== managedStorageGenerationRef.current
            || suppressedManagedRecordIdsRef.current.has(activePrepared.signed.id))
          && !(reason instanceof TradeRecordApiRequestError && reason.code === "RECORD_REVOKED")) {
          setManagedTradeRecords((current) => upsertManagedTradeRecord(current, uncertainRecord));
          setShareStatus("오류: 카드 전달 뒤 공개 확정 결과를 확인하지 못했고 처리 중 브라우저 데이터가 삭제되어 철회 권한을 다시 저장하지 않았습니다. 이 화면에서 철회하거나 상세 링크 상태를 확인하십시오.");
          return;
        }
        if (removedManagedRecordIdsRef.current.has(activePrepared.signed.id)
          || (reason instanceof TradeRecordApiRequestError && reason.code === "RECORD_REVOKED")) {
          removedManagedRecordIdsRef.current.add(activePrepared.signed.id);
          suppressedManagedRecordIdsRef.current.delete(activePrepared.signed.id);
          knownManagedRecordsRef.current.delete(activePrepared.signed.id);
          try {
            removePersistedManagedTradeRecord(window.localStorage, activePrepared.signed.id);
          } catch {
            // The local tombstone still prevents the revoked capability from being recreated.
          }
          setManagedTradeRecords((current) => removeManagedTradeRecord(current, activePrepared.signed.id));
          preparedTradeShareRef.current = null;
          setPreparedTradeShare(null);
          shareAttemptCacheRef.current = null;
          setShareStatus("공개 확정 처리 중 다른 탭에서 기록이 철회되었습니다. 전달된 카드의 상세 링크는 열리지 않습니다.");
          return;
        }
        rememberManagedRecord(
          uncertainRecord,
          finalizationStorageGeneration ?? managedStorageGenerationRef.current,
        );
        setShareStatus(reason instanceof Error
          ? `오류: 카드는 전달되었지만 상세 기록을 공개 확정하지 못했습니다. ${reason.message} 같은 버튼으로 확정을 재시도하거나 준비 기록을 철회하십시오.`
          : "오류: 카드는 전달되었지만 상세 기록을 공개 확정하지 못했습니다. 같은 버튼으로 재시도하거나 준비 기록을 철회하십시오.");
      }
    } finally {
      isSharingRef.current = false;
      setIsSharing(false);
      releasePreparedReference();
    }
  }

  async function cancelPreparedTrade() {
    const prepared = preparedTradeShareRef.current;
    if (!prepared || isSharing) return;
    isSharingRef.current = true;
    setIsSharing(true);
    try {
      await revokeKnownRecord(
        toManagedTradeRecord(prepared.signed, prepared.revokeToken),
        prepared.deliveryOutcome
          ? "전달 후 공개 확정하지 못한 준비 기록을 철회했습니다. 카드의 상세 링크는 열리지 않습니다."
          : "준비한 비공개 카드와 거래 기록을 폐기했습니다.",
      );
    } finally {
      isSharingRef.current = false;
      setIsSharing(false);
      releasePreparedReference();
    }
  }

  async function revokeManagedTradeRecord(record: ManagedTradeRecord) {
    if (isSharing) return;
    const lifecycleLabel = record.lifecycle === "finalized"
      ? "공개 기록"
      : record.lifecycle === "finalizing"
        ? "확정 상태를 확인 중인 기록"
        : "준비 기록";
    if (!window.confirm(`${lifecycleLabel}을 철회하시겠습니까?\n식별자: ${record.id}\n이 작업은 되돌릴 수 없습니다.`)) return;
    isSharingRef.current = true;
    setIsSharing(true);
    try {
      await revokeKnownRecord(
        record,
        record.lifecycle === "finalized"
          ? "공개 거래 기록을 철회했습니다. 기존 상세 링크는 더 이상 열리지 않습니다."
          : "공개 확정 전 기록을 철회했습니다. 전달된 카드의 상세 링크는 열리지 않습니다.",
      );
    } finally {
      isSharingRef.current = false;
      setIsSharing(false);
      releasePreparedReference();
    }
  }

  useEffect(() => {
    const prepared = preparedTradeShare;
    if (!prepared) {
      autoRevokingRecordIdRef.current = "";
      return;
    }
    if (preparedShareIsCurrent && shareImageAllowed) {
      if (!isSharingRef.current) autoRevokingRecordIdRef.current = "";
      return;
    }
    if (isSharingRef.current || autoRevokingRecordIdRef.current === prepared.signed.id) return;

    autoRevokingRecordIdRef.current = prepared.signed.id;
    isSharingRef.current = true;
    void (async () => {
      setIsSharing(true);
      try {
        await revokeKnownRecord(
          toManagedTradeRecord(prepared.signed, prepared.revokeToken),
          "거래 조건 또는 시세가 바뀌어 비공개 준비 기록을 자동으로 폐기했습니다.",
        );
      } finally {
        isSharingRef.current = false;
        setIsSharing(false);
        if (!preparedTradeShareRef.current && !paymentLockRef.current) {
          const pendingSnapshot = pendingMarketSnapshotRef.current;
          if (pendingSnapshot) {
            pendingMarketSnapshotRef.current = null;
            applyMarketSnapshot(pendingSnapshot, true);
          }
        }
      }
    })();
  }, [applyMarketSnapshot, preparedShareIsCurrent, preparedTradeShare, revokeKnownRecord, shareImageAllowed]);

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

  function changeTradeRole(nextRole: TradeRole) {
    if (nextRole === tradeRole) return;
    if (amountBasis === "krw") {
      const nextKrw = quote ? String(quote.paymentKrw) : krwAmount;
      setKrwAmounts((current) => ({ ...current, [nextRole]: nextKrw }));
      setAmountBasisByRole((current) => ({ ...current, [nextRole]: "krw" }));
    } else {
      const nextBitcoin = quote
        ? bitcoinDisplayUnit === "btc" ? satsToBtcInput(quote.sats) : String(quote.sats)
        : bitcoinAmountInput;
      setBitcoinAmountInputs((current) => ({ ...current, [nextRole]: nextBitcoin }));
      setAmountBasisByRole((current) => ({ ...current, [nextRole]: "bitcoin" }));
    }
    setTradeRole(nextRole);
    setDraftStatus("역할을 바꾸어도 현재 거래 금액과 입력 단위를 유지했습니다.");
  }

  function clearSavedDraft() {
    const storage = getTradeDraftStorage();
    const removed = removeTradeDraft(storage);
    skipNextDraftPersistence.current = true;
    replaceDraftFields(freshDefaultTradeDraft());
    setDraftSyncRevision((current) => current + 1);
    setImportedTradeLink(false);
    setConfirmedLargeTradeKey("");
    setDraftStatus(removed
      ? "이 브라우저에 저장된 초안을 삭제하고 기본값으로 되돌렸습니다."
      : "초안 저장소에 접근하지 못했지만 화면은 기본값으로 되돌렸습니다.");
  }

  async function copyVerificationUrl(url: string) {
    if (!url) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setShareStatus("상세 정보 링크를 클립보드에 복사했습니다.");
    } catch {
      setShareStatus("오류: 상세 정보 링크를 자동으로 복사하지 못했습니다. 링크를 직접 열어 복사해 주세요.");
    }
  }

  return (
    <section
      className={`trade-tool ${draftHydrated ? "is-draft-hydrated" : "is-draft-hydrating"}`}
      aria-labelledby="tool-title"
      aria-busy={!draftHydrated}
    >
      {managedTradeRecordsHydrated && !isSharing
        ? finalizingManagedTradeRecords.map((record) => (
            <FinalizingTradeRecordReconciler
              key={record.id}
              record={record}
              acquirePermit={reconciliationScheduler.acquire}
              readStorageGeneration={readManagedStorageGeneration}
              onFinalized={handleFinalizingRecordFinalized}
              onInvalidCapability={handleFinalizingRecordInvalidCapability}
              onMissing={handleFinalizingRecordMissing}
            />
          ))
        : null}
      <article className="capture-card" data-capture-card>
        <header className="tool-heading">
          <div className="brand-line">
            <span className="brand-mark" aria-hidden="true">₿</span>
            <h1 id="tool-title">비트코인 P2P 계산기</h1>
          </div>
          <button
            className="refresh-button"
            type="button"
            aria-label={marketReferenceLocked
              ? paymentReferenceLocked
                ? "결제 QR 금액을 유지하는 동안 시세 새로고침을 사용할 수 없습니다"
                : "준비한 거래 기록의 금액을 유지하는 동안 시세 새로고침을 사용할 수 없습니다"
              : marketState === "loading" ? "업비트 시세와 온체인 수수료율 조회 중" : "업비트 시세와 온체인 수수료율 새로고침"}
            onClick={() => void loadMarket()}
            disabled={marketState === "loading" || isSharing || marketReferenceLocked}
          >
            {marketReferenceLocked ? "금액 고정 중" : marketState === "loading" ? "시세 조회 중" : "시세 새로고침"}
          </button>
        </header>

        <div className="market-strip" aria-label="거래 계산 기준과 시장 참고값">
          <div className="market-cell">
            <span>{referenceLabel}</span>
            <strong>{formatKrw(referencePrice)} <small>/ BTC</small></strong>
            <small className="live-market-time">
              {marketReferenceLocked
                ? <>{paymentReferenceLocked ? "결제 QR" : "공유 카드"} 금액 고정 · {formatTime(referenceTime)}</>
                : <LiveMarketTime active={livePriceActive} tradeObservedAt={referenceTime} />}
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
            공유된 거래 조건을 업비트 실시간 시세에 맞춰 다시 확인했습니다. 링크 값은 수정될 수 있으니 거래 전에 확인하세요.
          </p>
        ) : null}
        <p className="draft-storage-notice">
          <span>역할·금액·프리미엄은 이 브라우저에 12시간 자동 저장됩니다. 자금 출처는 저장하지 않습니다.</span>
          <button type="button" onClick={clearSavedDraft}>저장된 초안 삭제</button>
        </p>
        {draftStatus ? <p className="visually-hidden" role="status">{draftStatus}</p> : null}

        <fieldset className="role-fieldset">
          <legend>
            <span>나는 비트코인을</span>
            <small>시세는 합의의 기준일 뿐입니다.</small>
          </legend>
          <div className="role-options">
            <label htmlFor="trade-role-buyer" aria-label="비트코인을 삽니다. 원화를 보내고 비트코인을 받습니다.">
              <input id="trade-role-buyer" type="radio" name="trade-role" checked={tradeRole === "buyer"} onChange={() => changeTradeRole("buyer")} />
              <span><strong>삽니다</strong><small>원화 보내고 BTC 받기</small></span>
            </label>
            <label htmlFor="trade-role-seller" aria-label="비트코인을 팝니다. 비트코인을 보내고 원화를 받습니다.">
              <input id="trade-role-seller" type="radio" name="trade-role" checked={tradeRole === "seller"} onChange={() => changeTradeRole("seller")} />
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
                aria-describedby={`trade-rounding premium-note${bitcoinAmountError ? " bitcoin-amount-error" : ""}${tinyTradeWarning ? " tiny-trade-warning" : ""}${largeTradeKey ? " large-trade-warning" : ""}`}
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

          <div className="field">
            <label htmlFor="seller-premium">판매자 프리미엄 (%)</label>
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
                  disabled={premiumPercent !== null && premiumPercent >= MAX_PREMIUM_PERCENT}
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
          </div>
          <p className="premium-note" id="premium-note">{premiumSummary}</p>
          {premiumError ? <p className="input-alert" id="premium-error" role="alert">{premiumError}</p> : null}
          {premiumWarning ? <p className="input-alert" id="premium-warning" role="status">기준 시세와 10% 이상 차이 납니다. 입력값을 다시 확인하세요.</p> : null}
          {bitcoinAmountError ? <p className="input-alert" id="bitcoin-amount-error" role="alert">{bitcoinAmountError}</p> : null}
          {tinyTradeWarning ? <p className="input-alert" id="tiny-trade-warning" role="status">{tinyTradeWarning}</p> : null}
          {largeTradeKey ? (
            <div className="input-alert large-trade-confirmation" id="large-trade-warning" role="status">
              <strong>계산된 원화 금액이 10억원 이상입니다.</strong>
              <label>
                <input
                  type="checkbox"
                  checked={largeTradeConfirmed}
                  onChange={(event) => setConfirmedLargeTradeKey(event.target.checked ? largeTradeKey : "")}
                />
                자릿수와 거래 금액을 다시 확인했습니다.
              </label>
            </div>
          ) : null}
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
              <output className="visually-hidden" aria-live={resultLiveMode} aria-atomic="true">
                {currentResultAnnouncement}
              </output>
              <dl>
                <div className={`result-row transfer-row ${tradeRole === "seller" ? "primary" : ""}`}>
                  <dt>{tradeRole === "buyer" ? "내가 보낼 원화" : "내가 받을 원화"}</dt>
                  <dd>{formatKrw(quote.paymentKrw)}<small className="result-spacer" aria-hidden="true">&nbsp;</small></dd>
                </div>
                <div className={`result-row transfer-row ${tradeRole === "buyer" ? "primary" : ""}`}>
                  <dt>{tradeRole === "buyer" ? "내가 받을 BTC" : "내가 보낼 BTC"}</dt>
                  <dd>
                    {bitcoinDisplayUnit === "btc" ? formatBtc(quote.sats) : formatSats(quote.sats)}
                    <small>{bitcoinDisplayUnit === "btc" ? formatSats(quote.sats) : formatBtc(quote.sats)}</small>
                  </dd>
                </div>
                <div className="result-row">
                  <dt>적용 BTC 단가</dt>
                  <dd>{formatKrw(quote.appliedPriceKrw)}<small>{referenceLabel} {formatKrw(referencePrice)} × {multiplier.toLocaleString("ko-KR", { maximumFractionDigits: 4 })}</small></dd>
                </div>
              </dl>
            </>
          ) : <p className="result-empty" role="status">{resultUnavailable}</p>}
        </section>

        <div className="capture-meta" id="trade-rounding" role="note" aria-label="거래 계산 참고사항">
          <span className="capture-meta-fee" aria-label="수수료: 판매자 부담, 구매자 수령량 차감 없음"><b>수수료:</b><span>판매자 부담 · 구매자 수령량 차감 없음</span></span>
          <span className="capture-meta-rounding" aria-label="반올림: 1 sat, 1원"><b>반올림:</b><span>1 sat·1원</span></span>
          <span className="capture-meta-disclaimer" aria-label="거래 확인: 원화 입금과 비트코인 수령 내역 확인"><b>거래 확인:</b><span>원화 입금·BTC 수령 내역 확인</span></span>
        </div>
      </article>

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

      <details className="share-tools">
        <summary>
          <span>상대 찾기·공유하기</span>
          <small>모집글과 거래 기록 카드</small>
        </summary>
        <div className="share-tools-body">
          <section className="output-picker" aria-labelledby="output-picker-title">
            <fieldset>
              <legend className="visually-hidden" id="output-picker-title">만들 결과 선택</legend>
              <div className="output-options">
                <label htmlFor="output-mode-recruitment" aria-label="모집글. 공개 채널에서 거래 상대를 찾습니다.">
                  <input
                    id="output-mode-recruitment"
                    type="radio"
                    name="output-mode"
                    value="recruitment"
                    checked={outputMode === "recruitment"}
                    onChange={() => setOutputMode("recruitment")}
                  />
                  <span><strong>모집글</strong><small>공개 채널에서 상대 찾기</small></span>
                </label>
                <label htmlFor="output-mode-trade-image" aria-label="거래 기록 카드. 합의 조건과 선택한 결제 QR의 사이트 원본을 만듭니다.">
                  <input
                    id="output-mode-trade-image"
                    type="radio"
                    name="output-mode"
                    value="trade-image"
                    checked={outputMode === "trade-image"}
                    onChange={() => setOutputMode("trade-image")}
                  />
                  <span><strong>거래 기록 카드</strong><small>조건·선택 결제정보</small></span>
                </label>
              </div>
            </fieldset>
          </section>

          <div className="output-panel" hidden={outputMode !== "trade-image"}>
            <div className="record-card-intro">
              <strong>입력한 거래 조건을 한 장의 카드로 만듭니다.</strong>
              <p>결제 QR은 선택 사항이며, 상세 링크에서 조건 확인과 주소·인보이스 복사가 가능합니다.</p>
            </div>
            <div className="trade-image-funding">
              <label className="fund-source-field" htmlFor="buyer-funding-source">
                <span>{fundingSourceFieldLabel}<small>선택 사항</small></span>
                <select
                  id="buyer-funding-source"
                  value={fundingSource}
                  onChange={(event) => setFundingSource(event.target.value as FundingSource)}
                  aria-describedby="fund-source-note"
                >
                  {FUNDING_SOURCE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              <p className="fund-source-note" id="fund-source-note">{fundingSourceNote}</p>
            </div>
            {outputMode === "trade-image" ? (
              <TradeReceiveInfoPortal
                expectedSats={quote?.sats ?? null}
                conditionKey={receiveConditionKey}
                ownerRole={tradeRole}
                onResultChange={handleVerifiedReceiveInfo}
                onLifecycleChange={handleReceiveInfoLifecycle}
              />
            ) : null}
            {paymentLifecycleBlocksShare ? (
              <p className="record-payment-state" role="alert">
                <strong>결제정보를 다시 확인해야 합니다.</strong>
                <span>{receiveInfoLifecycleStatus === "stale"
                  ? "역할 또는 금액이 달라졌습니다. 현재 조건으로 결제정보를 다시 만들거나 삭제해 주세요."
                  : "인보이스가 만료되었거나 곧 만료됩니다. 새 인보이스를 발급하거나 결제정보를 삭제해 주세요."}</span>
              </p>
            ) : !paymentForRecord ? (
              <p className="record-payment-state" role="status">
                <strong>결제정보 미포함</strong>
                <span>카드에는 보관용 거래 기록 QR이 들어갑니다.</span>
              </p>
            ) : null}
            <aside className="share-disclosure" aria-label="거래 기록 저장과 공개 안내">
              <strong>공유 전 확인</strong>
              <p>공유 링크가 있으면 누구나 로그인 없이 최대 180일간 기록을 볼 수 있습니다.</p>
              <a href="/privacy/">개인정보 처리 안내 보기</a>
            </aside>
            <div className="tool-actions">
              <button
                className="share-button"
                type="button"
                onClick={() => {
                  if (preparedShareIsCurrent) void sharePreparedTrade();
                  else void prepareTradeShare();
                }}
                disabled={isSharing || !shareImageAllowed || (Boolean(preparedTradeShare) && !preparedShareIsCurrent)}
                aria-busy={isSharing}
              >
                {isSharing
                  ? preparedTradeShare?.deliveryOutcome
                    ? "상세 기록 공개 확정 중"
                    : preparedTradeShare ? "공유 처리 중" : "거래 기록 카드 준비 중"
                  : preparedShareIsCurrent
                    ? preparedTradeShare?.deliveryOutcome ? "상세 기록 공개 확정 재시도" : "공유 창 열기"
                  : !largeTradeConfirmed
                    ? "고액 거래 확인 후 준비"
                    : paymentLifecycleBlocksShare
                      ? "결제정보 재확인 후 준비"
                      : stalePrice
                        ? "시세 새로고침 후 준비"
                        : "거래 기록 카드 준비"}
              </button>
              {preparedTradeShare ? (
                <button
                  className="share-cancel-button"
                  type="button"
                  onClick={() => void cancelPreparedTrade()}
                  disabled={isSharing}
                >
                  {preparedTradeShare.deliveryOutcome ? "준비 기록 철회" : "준비 취소·기록 철회"}
                </button>
              ) : null}
              <p
                className={`share-status ${shareStatusIsError ? "is-error" : shareStatus ? "is-feedback" : "is-idle"}`}
                aria-live="polite"
                role={shareStatusIsError ? "alert" : undefined}
              >
                {shareStatus || (!isSharing ? "첫 단계에서는 15분짜리 비공개 준비 기록만 만듭니다." : "")}
              </p>
              {managedTradeRecords.length > 0 ? (
                <section className="managed-trade-records" aria-label="이 화면에서 만든 거래 기록 관리">
                  <strong>거래 기록 관리</strong>
                  <p>공개 기록은 만료 시까지 관리합니다. 확정 요청의 결과를 받지 못한 기록은 브라우저에 보관하고 서버의 공개 상태를 다시 확인합니다.</p>
                  {managedTradeRecords.some((record) => (
                    record.lifecycle === "finalized" && record.persistence === "memory-only"
                  )) ? (
                    <p className="is-error" role="alert">저장하지 못한 공개 기록의 철회 권한이 있습니다. 이 화면을 닫기 전에 철회하십시오.</p>
                  ) : null}
                  {managedTradeRecords.some((record) => (
                    record.lifecycle !== "finalized" && record.persistence === "memory-only"
                  )) ? (
                    <p className="is-error" role="alert">저장하지 못한 준비 기록의 철회 권한이 있습니다. 이 화면을 닫기 전에 재시도하거나 철회하십시오.</p>
                  ) : null}
                  <ul>
                    {managedTradeRecords.map((record) => (
                      <li key={record.id}>
                        <span>
                          <strong>{record.lifecycle === "finalized"
                            ? "공개 기록"
                            : record.lifecycle === "finalizing"
                              ? "확정 상태 확인 필요"
                              : "준비 기록"}</strong>
                          <small>
                            식별자 <code>{record.id}</code> · <time dateTime={managedTradeRecordDisplayDeadline(record)}>
                              {formatManagedRecordExpiry(managedTradeRecordDisplayDeadline(record))} {record.lifecycle === "finalizing" ? "확인 기한" : "만료"}
                            </time>
                          </small>
                        </span>
                        {record.lifecycle === "finalized" ? (
                          <>
                            <a href={record.verificationUrl} target="_blank" rel="noreferrer">열기</a>
                            <button type="button" onClick={() => void copyVerificationUrl(record.verificationUrl)} disabled={isSharing}>복사</button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void revokeManagedTradeRecord(record)}
                          disabled={isSharing}
                          aria-label={`${record.lifecycle === "finalized" ? "공개" : "확정 전"} 기록 ${record.id} 철회`}
                        >
                          철회
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </div>

          <div className="output-panel" hidden={outputMode !== "recruitment"}>
            <TradeRecruitmentTool
              active={outputMode === "recruitment"}
              tradeRole={tradeRole}
              amountUnit={amountInputUnit}
              amountInput={amountBasis === "krw" ? krwAmount : bitcoinAmountInput}
              sellerPremiumInput={premiumInput}
              approximateKrw={quote?.paymentKrw ?? null}
              approximateSats={quote?.sats ?? null}
              bitcoinDisplayUnit={bitcoinDisplayUnit}
            />
          </div>
        </div>
      </details>
    </section>
  );
}
