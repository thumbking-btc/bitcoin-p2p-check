"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { calculateP2PQuote, MAX_SATS, SATS_PER_BTC } from "../lib/p2p-quote.mjs";
import { isReferenceShareable, shareImageFile } from "../lib/share-transport.mjs";
import { createTradeShareImage, type TradeShareImageInput } from "../lib/trade-share-image";

type TradeRole = "buyer" | "seller";
type ReferenceMode = "upbit" | "manual";
type FocusedField = "krw" | "sats" | "manual" | null;

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

type MarketSnapshot = {
  checkedAt: string;
  status: "current" | "partial" | "stale" | "unavailable";
  priceKrw: number | null;
  priceObservedAt: string | null;
  koreaPremium: number | null;
};

async function requestMarketSnapshot() {
  const response = await fetch("/api/market", { cache: "no-store" });
  if (!response.ok) throw new Error("market request failed");
  const data = await response.json() as MarketSnapshot;
  if (!Number.isFinite(data.priceKrw) || Number(data.priceKrw) <= 0) {
    throw new Error("price unavailable");
  }
  return data;
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
  const [tradeRole, setTradeRole] = useState<TradeRole>("buyer");
  const [krwAmount, setKrwAmount] = useState("3000000");
  const [satsAmount, setSatsAmount] = useState("3000000");
  const [premiumInput, setPremiumInput] = useState("2");
  const [referenceMode, setReferenceMode] = useState<ReferenceMode>("upbit");
  const [manualPrice, setManualPrice] = useState("");
  const [manualReferencePrice, setManualReferencePrice] = useState<number | null>(null);
  const [manualAppliedAt, setManualAppliedAt] = useState<string | null>(null);
  const [fundingSources, setFundingSources] = useState<Record<TradeRole, FundingSource>>({
    buyer: "기재하지 않음",
    seller: "기재하지 않음",
  });
  const [focusedField, setFocusedField] = useState<FocusedField>(null);
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [marketState, setMarketState] = useState<"loading" | "ready" | "error">("loading");
  const [marketError, setMarketError] = useState("");
  const [priceExpired, setPriceExpired] = useState(false);
  const [shareStatus, setShareStatus] = useState("");
  const [isSharing, setIsSharing] = useState(false);
  const [shareImageGeneration, setShareImageGeneration] = useState(0);
  const [preparedShareImage, setPreparedShareImage] = useState<{
    key: string;
    file: File | null;
    failed: boolean;
  } | null>(null);

  const loadMarket = useCallback(async () => {
    setMarketState("loading");
    setMarketError("");
    setPriceExpired(false);
    try {
      const data = await requestMarketSnapshot();
      setMarket(data);
      setMarketState("ready");
    } catch {
      setMarketState("error");
      setPriceExpired(true);
      setMarketError("시세를 새로 불러오지 못했습니다. 마지막 조회값을 확인용으로만 표시합니다. 직접 시세를 입력해 계산할 수도 있습니다.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void requestMarketSnapshot().then(
      (data) => {
        if (!active) return;
        setMarket(data);
        setMarketState("ready");
      },
      () => {
        if (!active) return;
        setMarket(null);
        setMarketState("error");
        setMarketError("업비트 최근 체결가를 불러오지 못했습니다. 기준 시세를 직접 입력해 계산할 수 있습니다.");
      },
    );
    return () => {
      active = false;
    };
  }, []);

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
  const manualPriceNumber = numeric(manualPrice);
  const referencePrice = referenceMode === "upbit" ? market?.priceKrw ?? null : manualReferencePrice;
  const referenceLabel = referenceMode === "upbit" ? "업비트 최근 체결가" : "직접 입력 시세";
  const referenceTime = referenceMode === "upbit" ? market?.priceObservedAt ?? null : manualAppliedAt;
  const fundingSource = fundingSources[tradeRole];
  const fundingSourceFieldLabel = "구매자 자금 출처";
  const amount = tradeRole === "buyer" ? numeric(krwAmount) : numeric(satsAmount);

  const quote = useMemo(() => {
    if (amount === null || referencePrice === null || premiumPercent === null) return null;
    return calculateP2PQuote({
      mode: tradeRole === "buyer" ? "krw" : "sats",
      amount,
      referencePrice,
      premiumPercent,
    });
  }, [amount, premiumPercent, referencePrice, tradeRole]);

  const multiplier = premiumPercent === null ? null : 1 + premiumPercent / 100;
  const premiumSummary = premiumPercent === null
    ? "판매자 프리미엄을 입력하세요."
    : premiumPercent > 0
      ? `판매자가 기준 시세보다 ${premiumPercent.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}% 높은 단가로 팝니다.`
      : premiumPercent < 0
        ? `판매자가 기준 시세보다 ${Math.abs(premiumPercent).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}% 낮은 단가로 팝니다.`
        : "판매자가 기준 시세와 같은 단가로 팝니다.";
  const stalePrice = referenceMode === "upbit"
    && market !== null
    && (priceExpired || market.status === "stale" || marketState === "error");
  const inputOutOfRange = tradeRole === "seller" && amount !== null && amount > MAX_SATS;
  const resultUnavailable = premiumError || inputOutOfRange
    ? premiumError || "비트코인 수량이 지원 범위를 넘었습니다."
    : referencePrice === null
      ? marketState === "loading" ? "업비트 시세를 불러오는 중입니다." : "기준 시세를 입력하세요."
      : amount === null || amount <= 0
        ? "거래 금액을 입력하세요."
        : "입력값을 확인하세요.";

  const effectiveKoreaPremium = marketState === "ready" && !stalePrice && market?.status === "current"
    ? market?.koreaPremium ?? null
    : null;

  const shareText = quote && multiplier !== null ? [
    "[비트코인 P2P 거래 조건]",
    `기준: ${referenceLabel} ${formatKrw(referencePrice)} / BTC`,
    `시각: ${formatTime(referenceTime)}`,
    `판매자 프리미엄: ${premiumPercent}%`,
    `구매자 자금 출처: ${fundingSource} (구매자 제공 정보 · 상호 확인 필요)`,
    `구매자 → 판매자: ${formatKrw(quote.paymentKrw)}`,
    `판매자 → 구매자: ${formatSats(quote.sats)} (${formatBtc(quote.sats)})`,
    `판매자가 파는 BTC 가격: ${formatKrw(quote.appliedPrice)} / BTC`,
    `참고 업비트 프리미엄: ${formatPercent(effectiveKoreaPremium)}`,
    "온체인 송금 수수료 별도 · 1 sat/1원 반올림",
  ].join("\n") : "";

  const shareImageInput = useMemo<TradeShareImageInput | null>(() => {
    if (!quote || referencePrice === null || premiumPercent === null) return null;
    return {
      tradeRole,
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
  }, [effectiveKoreaPremium, fundingSource, premiumPercent, quote, referenceLabel, referencePrice, referenceTime, tradeRole]);

  const shareImageKey = shareImageInput ? JSON.stringify(shareImageInput) : "";
  const shareImageAllowed = Boolean(shareImageInput)
    && !stalePrice
    && (referenceMode === "manual" || marketState === "ready");
  const preparedShareFile = preparedShareImage?.key === shareImageKey ? preparedShareImage.file : null;
  const shareImageFailed = preparedShareImage?.key === shareImageKey && preparedShareImage.failed;
  const shareImagePreparing = shareImageAllowed && !preparedShareFile && !shareImageFailed;
  const shareStatusIsError = Boolean(shareStatus) && (shareImageFailed || shareStatus.includes("못") || shareStatus.includes("다시"));

  useEffect(() => {
    if (!shareImageInput || !shareImageAllowed) return;
    let active = true;
    const timeout = window.setTimeout(() => {
      void createTradeShareImage(shareImageInput).then(
        (file) => {
          if (!active) return;
          setPreparedShareImage({ key: shareImageKey, file, failed: false });
          setShareStatus("");
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
  }, [shareImageAllowed, shareImageGeneration, shareImageInput, shareImageKey]);

  async function shareTrade() {
    if (shareImageFailed) {
      setShareStatus("");
      setPreparedShareImage(null);
      setShareImageGeneration((value) => value + 1);
      return;
    }
    if (!shareText || !preparedShareFile || isSharing) return;
    if (stalePrice || !isReferenceShareable({ referenceMode, marketState, referenceTime }, Date.now())) {
      setPriceExpired(true);
      setShareStatus("최신 시세를 다시 조회한 뒤 거래 조건을 공유해 주세요.");
      return;
    }
    setShareStatus("");
    setIsSharing(true);
    try {
      const outcome = await shareImageFile({
        file: preparedShareFile,
        title: "비트코인 P2P 거래 조건",
        text: shareText,
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
      setIsSharing(false);
    }
  }

  function applyManualPrice() {
    if (manualPriceNumber === null || manualPriceNumber <= 0) return;
    setManualReferencePrice(manualPriceNumber);
    setReferenceMode("manual");
    setManualAppliedAt(new Date().toISOString());
  }

  return (
    <section className="trade-tool" aria-labelledby="tool-title">
      <article className="capture-card" data-capture-card>
        <header className="tool-heading">
          <div className="brand-line">
            <span className="brand-mark" aria-hidden="true">₿</span>
            <h1 id="tool-title">비트코인 P2P 계산기</h1>
          </div>
          <button
            className="refresh-button"
            type="button"
            aria-label={marketState === "loading" ? "업비트 시세 조회 중" : "업비트 시세 새로고침"}
            onClick={() => void loadMarket()}
            disabled={marketState === "loading"}
          >
            {marketState === "loading" ? "시세 조회 중" : "시세 새로고침"}
          </button>
        </header>

        <div className="market-strip" aria-label="거래 계산 기준과 시장 참고값">
          <div className="market-cell">
            <span>{referenceLabel}</span>
            <strong>{formatKrw(referencePrice)} <small>/ BTC</small></strong>
            <small>{formatTime(referenceTime)}</small>
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
          {tradeRole === "buyer" ? (
            <label className="field" htmlFor="trade-krw">
              <span>보낼 원화</span>
              <span className="input-with-unit">
                <input id="trade-krw" inputMode="numeric" value={focusedField === "krw" ? krwAmount : grouped(krwAmount)} onFocus={() => setFocusedField("krw")} onBlur={() => setFocusedField(null)} onChange={(event) => setKrwAmount(digitsOnly(event.target.value, 15))} aria-describedby="trade-rounding premium-note" />
                <b>원</b>
              </span>
            </label>
          ) : (
            <label className="field" htmlFor="trade-sats">
              <span>보낼 사토시</span>
              <span className="input-with-unit">
                <input
                  id="trade-sats"
                  inputMode="numeric"
                  value={focusedField === "sats" ? satsAmount : grouped(satsAmount)}
                  onFocus={() => setFocusedField("sats")}
                  onBlur={() => setFocusedField(null)}
                  onChange={(event) => setSatsAmount(digitsOnly(event.target.value, 16))}
                  aria-describedby={`trade-rounding premium-note${inputOutOfRange ? " sats-error" : ""}`}
                  aria-invalid={inputOutOfRange || undefined}
                />
                <b>sats</b>
              </span>
            </label>
          )}

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
              <b>%</b>
            </span>
          </label>
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
          <p className="premium-note" id="premium-note">{premiumSummary}</p>
          <p className="fund-source-note" id="fund-source-note">구매자가 제공한 정보이며, 거래 전에 서로 확인해 주세요.</p>
          {premiumError ? <p className="input-alert" id="premium-error" role="alert">{premiumError}</p> : null}
          {premiumWarning ? <p className="input-alert" id="premium-warning" role="status">기준 시세와 10% 이상 차이 납니다. 입력값을 다시 확인하세요.</p> : null}
          {inputOutOfRange ? <p className="input-alert" id="sats-error" role="alert">비트코인 수량이 지원 범위를 넘었습니다.</p> : null}
        </form>

        <section className="trade-result" aria-labelledby="result-title">
          <header className="result-head">
            <h2 id="result-title">거래 조건</h2>
            <span>{tradeRole === "buyer" ? "구매 금액 기준" : "판매 수량 기준"}</span>
          </header>
          {quote && multiplier !== null ? (
            <>
              <output className="visually-hidden" aria-live="polite" aria-atomic="true">
                구매자는 판매자에게 {formatKrw(quote.paymentKrw)}을 보내고, 판매자는 구매자에게 {formatSats(quote.sats)}를 보냅니다.
              </output>
              <dl>
                <div className={`result-row transfer-row ${tradeRole === "seller" ? "primary" : ""}`}>
                  <dt>구매자 → 판매자</dt>
                  <dd>{formatKrw(quote.paymentKrw)}<small className="result-spacer" aria-hidden="true">&nbsp;</small></dd>
                </div>
                <div className={`result-row transfer-row ${tradeRole === "buyer" ? "primary" : ""}`}>
                  <dt>판매자 → 구매자</dt>
                  <dd>{formatSats(quote.sats)}<small>{formatBtc(quote.sats)}</small></dd>
                </div>
                <div className="result-row">
                  <dt>판매자가 파는 BTC 가격</dt>
                  <dd>{formatKrw(quote.appliedPrice)}<small>{referenceLabel} {formatKrw(referencePrice)} × {multiplier.toLocaleString("ko-KR", { maximumFractionDigits: 4 })}</small></dd>
                </div>
              </dl>
            </>
          ) : <p className="result-empty">{resultUnavailable}</p>}
        </section>

        <p className="capture-meta" id="trade-rounding">
          <span>{referenceLabel} · {formatTime(referenceTime)}</span>
          <span>온체인 송금 수수료 별도 · 1 sat·1원 반올림</span>
          <span>거래 전 조건 확인용 · 입금 및 비트코인 수령 증빙이 아닙니다.</span>
        </p>
      </article>

      <div className="tool-actions">
        <button
          className="share-button"
          type="button"
          onClick={() => void shareTrade()}
          disabled={!shareImageAllowed || isSharing || (shareImagePreparing && !shareImageFailed)}
          aria-busy={isSharing || shareImagePreparing}
        >
          {isSharing
            ? "거래 조건 공유 중"
            : shareImageFailed
              ? "거래 조건 다시 준비"
              : shareImagePreparing
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
          {shareStatus || (!isSharing && !shareImagePreparing ? "입력값은 이 사이트에 저장되지 않습니다." : "")}
        </p>
      </div>

      {marketError && referenceMode === "upbit" ? <p className="market-error" role="alert">{marketError}</p> : null}

      <details className="price-settings">
        <summary>
          <span>기준 시세 직접 입력</span>
          <strong>{referenceMode === "manual" ? "직접 입력" : "업비트"} · {formatKrw(referencePrice)}</strong>
        </summary>
        <div className="settings-body">
          <label className="field" htmlFor="manual-price">
            <span>1 BTC 가격</span>
            <span className="input-with-unit">
              <input id="manual-price" inputMode="numeric" value={focusedField === "manual" ? manualPrice : grouped(manualPrice)} onFocus={() => setFocusedField("manual")} onBlur={() => setFocusedField(null)} onChange={(event) => setManualPrice(digitsOnly(event.target.value, 15))} placeholder="예: 100,000,000" aria-describedby="manual-price-note" />
              <b>원/BTC</b>
            </span>
          </label>
          <button className="secondary-button" type="button" onClick={applyManualPrice} disabled={manualPriceNumber === null || manualPriceNumber <= 0}>이 가격 사용</button>
          {referenceMode === "manual" ? <button className="secondary-button" type="button" onClick={() => setReferenceMode("upbit")} disabled={!market?.priceKrw}>업비트 시세로 돌아가기</button> : null}
          <p className="settings-note" id="manual-price-note">직접 입력한 가격을 사용하면 적용 시각도 거래 조건에 함께 기록됩니다.</p>
        </div>
      </details>
    </section>
  );
}
