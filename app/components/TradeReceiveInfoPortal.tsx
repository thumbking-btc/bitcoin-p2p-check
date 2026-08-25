"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAX_BOLT11_LENGTH, validateBolt11Invoice } from "../lib/bolt11-invoice.mjs";
import { createOnchainRequest } from "../lib/onchain-request.mjs";
import { getPaymentExpiryState, PAYMENT_EXPIRING_THRESHOLD_SECONDS } from "../lib/payment-lifecycle";
import { normalizeLightningAddress } from "../lib/lightning-address-normalize";
import styles from "./trade-receive-info.module.css";

export type ReceiveRail = "onchain" | "lightning";
type Rail = ReceiveRail;
type LightningMode = "address" | "invoice";
type PasteTarget = "onchain" | "lightning" | "invoice";
export type VerifiedReceiveInfo = Readonly<{
  kind: "onchain-address" | "onchain-request" | "lightning-address" | "lightning-generated" | "lightning-invoice";
  rail: Rail;
  amountSats: number;
  payload: string;
  copyTarget: string;
  address?: string;
  expiresAt?: number;
}>;
export type ReceiveInfoLifecycleState =
  | Readonly<{ status: "empty"; info: null; remainingSeconds: null }>
  | Readonly<{ status: "ready"; info: VerifiedReceiveInfo; remainingSeconds: number | null }>
  | Readonly<{ status: "stale"; info: VerifiedReceiveInfo; remainingSeconds: number | null }>
  | Readonly<{ status: "expiring" | "expired"; info: VerifiedReceiveInfo; remainingSeconds: number }>;
type Result = VerifiedReceiveInfo & {
  conditionKey: string;
  ownerRole: "buyer" | "seller";
};
type LightningPayResponse = {
  ok?: boolean;
  amountSats?: number;
  invoice?: string;
  message?: string;
  normalizedSource?: string;
  sourceType?: "address" | "lnurl" | "url";
  address?: string;
};

const MIN_SHARE_REMAINING_SECONDS = PAYMENT_EXPIRING_THRESHOLD_SECONDS;

function formatSats(value: number) {
  return `${value.toLocaleString("ko-KR")} sats`;
}

function formatExpiry(seconds: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1_000));
}

function formatRemaining(seconds: number) {
  if (seconds <= 0) return "만료됨";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")} 남음`;
}

function invoiceLike(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("lnbc") || normalized.startsWith("lightning:lnbc");
}

function lightningAddressLike(value: string) {
  try {
    normalizeLightningAddress(value.trim());
    return true;
  } catch {
    return false;
  }
}

function parseBip21AmountSats(value: string) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/u.exec(value);
  if (!match) throw new Error("BIP21 금액은 소수점 아래 8자리 이내의 BTC 수량이어야 합니다.");
  return BigInt(match[1]) * BigInt(100_000_000) + BigInt((match[2] ?? "").padEnd(8, "0"));
}

function onchainTargetFromInput(value: string, amountSats: number) {
  const trimmed = value.trim();
  if (!/^bitcoin:/iu.test(trimmed)) return { address: trimmed, amountIncluded: false } as const;
  if (/^bitcoin:\/\//iu.test(trimmed) || trimmed.includes("#")) {
    throw new Error("bitcoin: 뒤에 메인넷 주소 한 개가 있는 BIP21만 사용할 수 있습니다.");
  }

  const body = trimmed.slice("bitcoin:".length);
  const separator = body.indexOf("?");
  const address = separator < 0 ? body : body.slice(0, separator);
  const query = separator < 0 ? "" : body.slice(separator + 1);
  if (!address || address.includes("%")) {
    throw new Error("BIP21의 비트코인 주소 형식을 확인하지 못했습니다.");
  }

  const parameters = new URLSearchParams(query);
  if ([...parameters.keys()].some((key) => key.toLowerCase().startsWith("req-"))) {
    throw new Error("지원하지 않는 필수 항목이 있는 BIP21은 사용할 수 없습니다.");
  }
  const amounts = parameters.getAll("amount");
  if (amounts.length > 1) throw new Error("BIP21에는 금액을 한 번만 넣을 수 있습니다.");

  const request = createOnchainRequest(address, BigInt(amountSats));
  if (amounts.length === 1 && parseBip21AmountSats(amounts[0]) !== BigInt(amountSats)) {
    throw new Error("BIP21 금액이 현재 거래에서 받을 금액과 정확히 일치하지 않습니다.");
  }
  return { address: request.address, amountIncluded: amounts.length === 1 } as const;
}

async function readLightningPayResponse(response: Response): Promise<LightningPayResponse> {
  const text = await response.text();
  if (!text) throw new Error(`라이트닝 결제 요청 서버가 빈 응답을 반환했습니다. (HTTP ${response.status})`);
  try {
    return JSON.parse(text) as LightningPayResponse;
  } catch {
    const contentType = response.headers.get("content-type") ?? "알 수 없음";
    const preview = text.replace(/\s+/gu, " ").trim().slice(0, 120);
    throw new Error(`라이트닝 API가 JSON이 아닌 응답을 반환했습니다. (HTTP ${response.status}, ${contentType})${preview ? ` · ${preview}` : ""}`);
  }
}

export type TradeReceiveInfoProps = {
  expectedSats: number | null;
  conditionKey: string;
  ownerRole: "buyer" | "seller";
  onResultChange: (info: VerifiedReceiveInfo | null) => void;
  /**
   * Unlike the compatibility callback above, this reports why an existing
   * payment request became unusable instead of reducing every state to null.
   */
  onLifecycleChange?: (state: ReceiveInfoLifecycleState) => void;
};

export function TradeReceiveInfoPortal({ expectedSats, conditionKey, ownerRole, onResultChange, onLifecycleChange }: TradeReceiveInfoProps) {
  const [rail, setRail] = useState<Rail>("onchain");
  const [lightningMode, setLightningMode] = useState<LightningMode>("address");
  const [onchain, setOnchain] = useState("");
  const [lightningSource, setLightningSource] = useState("");
  const [invoice, setInvoice] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));
  const generationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const onResultChangeRef = useRef(onResultChange);
  const onLifecycleChangeRef = useRef(onLifecycleChange);

  const paymentExpiry = useMemo(
    () => getPaymentExpiryState(result?.expiresAt, nowSeconds),
    [nowSeconds, result?.expiresAt],
  );
  const remainingSeconds = paymentExpiry.remainingSeconds;

  const resultStale = Boolean(result && (
    expectedSats !== result.amountSats
    || conditionKey !== result.conditionKey
    || ownerRole !== result.ownerRole
  ));
  const resultExpiring = paymentExpiry.status === "expiring" || paymentExpiry.status === "expired";
  const resultReady = Boolean(result && !resultStale && !resultExpiring);

  useEffect(() => {
    generationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
  }, [conditionKey, expectedSats, ownerRole]);

  useLayoutEffect(() => {
    onResultChangeRef.current = onResultChange;
    onLifecycleChangeRef.current = onLifecycleChange;
  }, [onLifecycleChange, onResultChange]);

  const resultInfo = useMemo<VerifiedReceiveInfo | null>(() => {
    if (!result) return null;
    return Object.freeze({
      kind: result.kind,
      rail: result.rail,
      amountSats: result.amountSats,
      payload: result.payload,
      copyTarget: result.copyTarget,
      address: result.address,
      expiresAt: result.expiresAt,
    });
  }, [result]);

  const lifecycleState = useMemo<ReceiveInfoLifecycleState>(() => {
    if (!resultInfo) return Object.freeze({ status: "empty", info: null, remainingSeconds: null });
    if (paymentExpiry.status === "expired") {
      return Object.freeze({ status: "expired", info: resultInfo, remainingSeconds: paymentExpiry.remainingSeconds });
    }
    if (paymentExpiry.status === "expiring") {
      return Object.freeze({ status: "expiring", info: resultInfo, remainingSeconds: paymentExpiry.remainingSeconds });
    }
    if (resultStale) {
      return Object.freeze({ status: "stale", info: resultInfo, remainingSeconds: paymentExpiry.remainingSeconds });
    }
    return Object.freeze({ status: "ready", info: resultInfo, remainingSeconds: paymentExpiry.remainingSeconds });
  }, [paymentExpiry, resultInfo, resultStale]);

  const verifiedInfo = resultReady && lifecycleState.status === "ready" ? lifecycleState.info : null;

  useLayoutEffect(() => {
    onResultChangeRef.current(verifiedInfo);
  }, [verifiedInfo]);

  useLayoutEffect(() => {
    onLifecycleChangeRef.current?.(lifecycleState);
  }, [lifecycleState]);

  useEffect(() => () => {
    generationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    onResultChangeRef.current(null);
    onLifecycleChangeRef.current?.(Object.freeze({ status: "empty", info: null, remainingSeconds: null }));
  }, []);

  useEffect(() => {
    if (!result?.expiresAt) return;
    const tick = () => setNowSeconds(Math.floor(Date.now() / 1_000));
    tick();
    const timer = window.setInterval(tick, 1_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [result?.expiresAt]);

  function clear() {
    generationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    onResultChangeRef.current(null);
    setResult(null);
    setError("");
    setFeedback("");
    setBusy(false);
  }

  function changeLightningSource(value: string) {
    if (invoiceLike(value)) {
      clear();
      setInvoice(value.slice(0, MAX_BOLT11_LENGTH));
      setLightningSource("");
      setLightningMode("invoice");
      setFeedback("BOLT11 인보이스로 인식하여 직접 입력 방식으로 전환했습니다.");
      return;
    }
    clear();
    setLightningSource(value.slice(0, 2_048));
  }

  async function pasteFromClipboard(target: PasteTarget) {
    if (busy) return;
    if (!navigator.clipboard?.readText) {
      setError("이 브라우저는 붙여넣기 버튼을 지원하지 않습니다. 입력칸을 길게 눌러 붙여넣으십시오.");
      return;
    }
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        setError("클립보드에 붙여넣을 텍스트가 없습니다.");
        return;
      }
      if (target === "onchain") {
        clear();
        setOnchain(text.slice(0, 220));
        setFeedback("클립보드의 온체인 주소를 붙여넣었습니다.");
        return;
      }
      if (target === "lightning") {
        changeLightningSource(text);
        if (!invoiceLike(text)) setFeedback("클립보드의 라이트닝 수취정보를 붙여넣었습니다.");
        return;
      }
      clear();
      setInvoice(text.slice(0, MAX_BOLT11_LENGTH));
      setFeedback("클립보드의 BOLT11 인보이스를 붙여넣었습니다.");
    } catch {
      setError("클립보드를 읽지 못했습니다. 입력칸을 길게 눌러 붙여넣으십시오.");
    }
  }

  function makeLightningInvoiceResult(rawInvoice: string, amountSats: number, generated: boolean): Result {
    const checked = validateBolt11Invoice(rawInvoice, {
      expectedSats: BigInt(amountSats),
      minimumRemainingSeconds: MIN_SHARE_REMAINING_SECONDS,
    });
    return {
      kind: generated ? "lightning-generated" : "lightning-invoice",
      rail: "lightning",
      amountSats,
      conditionKey,
      ownerRole,
      payload: checked.canonicalInvoice,
      copyTarget: checked.canonicalInvoice,
      expiresAt: checked.expiresAt,
    };
  }

  function makeLightningAddressResult(source: string, amountSats: number): Result {
    let address: string;
    try {
      address = normalizeLightningAddress(source.trim()).address;
    } catch {
      throw new Error("주소만 포함하려면 사용자명@도메인 형식의 라이트닝 주소를 입력하십시오.");
    }
    return {
      kind: "lightning-address",
      rail: "lightning",
      amountSats,
      conditionKey,
      ownerRole,
      payload: address,
      copyTarget: address,
      address,
    };
  }

  async function build(forceOnchainAmountIncluded?: boolean) {
    if (busy) return;
    clear();
    if (!expectedSats) {
      setError("거래 금액을 먼저 계산하십시오.");
      return;
    }

    if (rail === "onchain") {
      try {
        const target = onchainTargetFromInput(onchain, expectedSats);
        const request = createOnchainRequest(target.address, BigInt(expectedSats));
        const amountIncluded = forceOnchainAmountIncluded ?? target.amountIncluded;
        setResult({
          kind: amountIncluded ? "onchain-request" : "onchain-address",
          rail: "onchain",
          amountSats: expectedSats,
          conditionKey,
          ownerRole,
          payload: amountIncluded ? request.uri : request.address,
          copyTarget: amountIncluded ? request.uri : request.address,
          address: request.address,
        });
        setFeedback(amountIncluded ? "현재 거래 금액이 포함된 온체인 QR을 준비했습니다." : "온체인 주소만 거래 기록 카드에 포함합니다.");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "온체인 수취정보를 확인하지 못했습니다.");
      }
      return;
    }

    if (lightningMode === "invoice") {
      if (!invoice.trim()) {
        setError("BOLT11 인보이스를 입력하십시오.");
        return;
      }
      try {
        const next = makeLightningInvoiceResult(invoice, expectedSats, false);
        setNowSeconds(Math.floor(Date.now() / 1_000));
        setResult(next);
        setFeedback("인보이스의 메인넷·금액·서명·만료시간을 확인했습니다.");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "라이트닝 인보이스를 확인하지 못했습니다.");
      }
      return;
    }

    const source = lightningSource.trim();
    if (!source) {
      setError("라이트닝 주소 또는 LNURL-pay를 입력하십시오.");
      return;
    }

    const isAddress = lightningAddressLike(source);
    setBusy(true);
    setFeedback("결제에 사용할 새 인보이스를 요청하고 있습니다.");
    const generation = generationRef.current;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);

    try {
      const endpoint = isAddress
        ? "/api/market?receive=lightning-address"
        : "/api/market?receive=lightning-pay";
      const body = isAddress
        ? { address: source, amountSats: expectedSats }
        : { source, amountSats: expectedSats };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      const data = await readLightningPayResponse(response);
      if (!response.ok || !data.ok || typeof data.invoice !== "string" || data.amountSats !== expectedSats) {
        throw new Error(data.message || `라이트닝 수취정보에서 인보이스를 만들지 못했습니다. (HTTP ${response.status})`);
      }
      if (generationRef.current !== generation) return;
      const next = makeLightningInvoiceResult(data.invoice, expectedSats, true);
      if (generationRef.current !== generation) return;
      setNowSeconds(Math.floor(Date.now() / 1_000));
      setResult(next);
      const normalized = isAddress ? data.address : data.normalizedSource;
      if (typeof normalized === "string") setLightningSource(normalized);
      setError("");
      setFeedback("지금 결제할 수 있는 새 고정금액 인보이스를 만들었습니다.");
    } catch (reason) {
      if (generationRef.current !== generation) return;
      if (controller.signal.aborted) {
        setError("라이트닝 지갑 서비스의 응답 시간이 초과되었습니다. 다시 시도하거나 인보이스를 직접 입력하십시오.");
      } else {
        setError(reason instanceof Error ? reason.message : "라이트닝 결제 요청을 만들지 못했습니다.");
      }
      setFeedback("");
    } finally {
      window.clearTimeout(timeout);
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      setBusy(false);
    }
  }

  const buildLabel = lightningMode === "address"
      ? busy ? "인보이스 요청 중" : result?.kind === "lightning-generated" ? "새 인보이스 만들기" : "결제 직전 인보이스 만들기"
      : "인보이스 확인";

  function includeLightningAddress() {
    clear();
    if (!expectedSats) {
      setError("거래 금액을 먼저 계산하십시오.");
      return;
    }
    try {
      setResult(makeLightningAddressResult(lightningSource, expectedSats));
      setFeedback("라이트닝 주소를 거래 기록 카드에 포함합니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "라이트닝 주소를 확인하지 못했습니다.");
    }
  }

  return (
    <section className={styles.section} aria-labelledby="receive-info-title">
      <div className={styles.header}>
        <h3 id="receive-info-title">{ownerRole === "buyer" ? "내 BTC 받을 정보" : "구매자가 제공한 BTC 받을 정보"} <span>(선택 사항)</span></h3>
      </div>
      <p className={styles.intro}>{ownerRole === "buyer"
        ? "내가 받을 주소나 인보이스를 거래 기록 카드에 함께 넣을 수 있습니다."
        : "구매자가 확인해 준 주소나 인보이스를 거래 기록 카드에 함께 넣을 수 있습니다."}</p>
      <p className={styles.amountNote}>현재 거래에서 받을 금액 <b>{expectedSats ? formatSats(expectedSats) : "계산 전"}</b></p>

      <fieldset className={styles.railPicker} disabled={busy}>
        <legend>BTC 전송 방식</legend>
        <label>
          <input aria-label="온체인" type="radio" name="embedded-receive-rail" checked={rail === "onchain"} onChange={() => { clear(); setRail("onchain"); }} />
          <span><strong>온체인</strong><small>비트코인 주소</small></span>
        </label>
        <label>
          <input aria-label="라이트닝" type="radio" name="embedded-receive-rail" checked={rail === "lightning"} onChange={() => { clear(); setRail("lightning"); setLightningMode("address"); }} />
          <span><strong>라이트닝</strong><small>주소·LNURL 또는 인보이스</small></span>
        </label>
      </fieldset>

      {rail === "onchain" ? (
        <div className={styles.field}>
          <label htmlFor="receive-onchain">온체인 수취 주소</label>
          <div className={styles.inputRow}>
            <input id="receive-onchain" className={styles.input} value={onchain} disabled={busy} maxLength={220} onChange={(event) => { clear(); setOnchain(event.target.value); }} placeholder="bc1q... · bc1p... · bitcoin:..." />
            <button className={styles.modeButton} type="button" disabled={busy} onClick={() => void pasteFromClipboard("onchain")}>붙여넣기</button>
          </div>
          <small>주소만 포함하거나, 현재 거래 금액을 넣은 BIP21 결제 QR을 만들 수 있습니다.</small>
        </div>
      ) : (
        <>
          <div className={styles.modeRow}>
            <p>{lightningMode === "address"
              ? "주소만 포함하거나, 실제 결제에 사용할 고정금액 인보이스를 만들 수 있습니다."
              : "지갑에서 직접 만든 인보이스를 거래 금액과 대조합니다."}</p>
            <button className={styles.modeButton} type="button" disabled={busy} onClick={() => { clear(); setLightningMode(lightningMode === "address" ? "invoice" : "address"); }}>
              {lightningMode === "address" ? "인보이스 직접 입력" : "라이트닝 주소 사용"}
            </button>
          </div>
          {lightningMode === "address" ? (
            <div className={styles.field}>
              <label htmlFor="receive-lightning">라이트닝 주소 / LNURL-pay</label>
              <div className={styles.inputRow}>
                <input id="receive-lightning" className={styles.input} value={lightningSource} disabled={busy} onChange={(event) => changeLightningSource(event.target.value)} placeholder="username@example.com 또는 LNURL1..." />
                <button className={styles.modeButton} type="button" disabled={busy} onClick={() => void pasteFromClipboard("lightning")}>붙여넣기</button>
              </div>
                  <small>주소만 포함하면 만료 없이 주소를 공유합니다. 인보이스 만들기는 현재 거래 금액의 새 BOLT11을 요청합니다.</small>
            </div>
          ) : (
            <div className={styles.field}>
              <label htmlFor="receive-invoice">BOLT11 인보이스</label>
              <div className={styles.inputRow}>
                <textarea id="receive-invoice" className={styles.textarea} value={invoice} disabled={busy} maxLength={MAX_BOLT11_LENGTH} onChange={(event) => { clear(); setInvoice(event.target.value.slice(0, MAX_BOLT11_LENGTH)); }} placeholder="lnbc... 또는 lightning:lnbc..." />
                <button className={styles.modeButton} type="button" disabled={busy} onClick={() => void pasteFromClipboard("invoice")}>붙여넣기</button>
              </div>
              <small>메인넷·서명·만료시간과 현재 거래의 받을 sats가 정확히 같은지 확인합니다.</small>
            </div>
          )}
        </>
      )}

          <div className={styles.actions}>
            {rail === "onchain" ? (
              <>
                <button className={styles.secondary} type="button" disabled={busy} onClick={() => void build(false)}>주소만 포함</button>
                <button className={styles.primary} type="button" disabled={busy} onClick={() => void build(true)}>금액 포함 QR 만들기</button>
              </>
            ) : rail === "lightning" && lightningMode === "address" ? (
              <button className={styles.secondary} type="button" disabled={busy} onClick={includeLightningAddress}>주소만 포함</button>
            ) : null}
            {rail !== "onchain" ? <button className={styles.primary} type="button" disabled={busy} onClick={() => void build()}>{buildLabel}</button> : null}
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => { clear(); setOnchain(""); setLightningSource(""); setInvoice(""); }}>초기화</button>
          </div>

      {error ? <p className={`${styles.status} ${styles.error}`} role="alert">{error}</p> : feedback ? <p className={styles.status} role="status">{feedback}</p> : null}

      {result ? (
        <div className={styles.result}>
          <div className={styles.resultInfo}>
                <span className={styles.resultBadge}>{result.kind === "onchain-address" ? "온체인 주소" : result.kind === "onchain-request" ? "금액 포함 온체인" : result.kind === "lightning-address" ? "라이트닝 주소" : "라이트닝 인보이스"}</span>
            <strong className={styles.resultAmount}>{formatSats(result.amountSats)}</strong>
            <p className={styles.lockNote}>이 결제정보를 사용하는 동안 거래 금액을 고정합니다. 초기화하면 최신 시세를 다시 반영합니다.</p>
                <dl>
                  <div className={styles.resultState}><dt>상태</dt><dd>{lifecycleState.status === "ready" ? "카드에 포함됨" : lifecycleState.status === "expiring" ? "곧 만료 · 포함 중지" : lifecycleState.status === "expired" ? "만료 · 포함 중지" : "조건 변경 · 포함 중지"}</dd></div>
              {result.expiresAt ? <div><dt>만료</dt><dd>{formatExpiry(result.expiresAt)} · {remainingSeconds === null ? "—" : formatRemaining(remainingSeconds)}</dd></div> : null}
            </dl>
            {resultStale ? <p className={styles.stale} role="alert">거래 조건이 바뀌었습니다. 현재 금액으로 다시 만들어야 공유할 수 있습니다.</p> : null}
            {lifecycleState.status === "expiring" ? <p className={styles.stale} role="alert">인보이스가 2분 안에 만료됩니다. 현재 인보이스는 거래 기록에 포함되지 않습니다. 지갑에서 새 인보이스를 만들어 다시 확인하십시오.</p> : null}
            {lifecycleState.status === "expired" ? <p className={styles.stale} role="alert">인보이스가 만료되어 거래 기록에 포함되지 않습니다. 지갑에서 새 인보이스를 만들어 다시 확인하십시오.</p> : null}
                <details className={styles.resultDetails}>
                  <summary>{result.kind === "lightning-invoice" || result.kind === "lightning-generated" ? "인보이스 보기" : "주소 보기"}</summary>
              <div className={styles.resultTarget}>
                    <span>{result.rail === "onchain" ? "온체인 주소" : result.kind === "lightning-address" ? "라이트닝 주소" : "BOLT11 인보이스"}</span>
                <code>{result.copyTarget}</code>
              </div>
            </details>
          </div>
        </div>
      ) : null}
    </section>
  );
}
