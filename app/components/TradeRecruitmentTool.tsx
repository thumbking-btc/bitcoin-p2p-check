"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildTradeRecruitmentPost,
  copyTradeRecruitmentText,
  syncTradeRecruitmentPreview,
} from "../lib/trade-recruitment.mjs";

type TradeRole = "buyer" | "seller";
type AmountUnit = "krw" | "sats" | "btc";
type TransferNetwork = "onchain" | "lightning" | "both";

type TradeRecruitmentToolProps = {
  tradeRole: TradeRole;
  amountUnit: AmountUnit;
  amountInput: string;
  sellerPremiumInput: string;
  approximateKrw: number | null;
  approximateSats: number | null;
};

function signedDecimalOnly(value: string) {
  const negative = value.trimStart().startsWith("-");
  const cleaned = value.replace(/[^\d.]/g, "");
  const [whole = "", ...fractionParts] = cleaned.split(".");
  const fraction = fractionParts.join("").slice(0, 2);
  const unsigned = cleaned.includes(".") ? `${whole || "0"}.${fraction}` : whole;
  if (!unsigned) return negative ? "-" : "";
  return `${negative ? "-" : ""}${unsigned}`;
}

function suggestedReturningPremium(value: string) {
  const premium = Number(value);
  if (!Number.isFinite(premium) || premium <= -99.99) return "";
  return String(Math.max(-99.99, Math.round((premium - 0.5) * 100) / 100));
}

function legacyCopy(value: string) {
  const textarea = document.createElement("textarea");
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  try {
    document.body.append(textarea);
    textarea.select();
    return document.execCommand("copy");
  } finally {
    textarea.remove();
    try {
      previousFocus?.focus({ preventScroll: true });
    } catch {
      try {
        previousFocus?.focus();
      } catch {
        // Focus recovery must not turn a successful legacy copy into a failure.
      }
    }
  }
}

export function TradeRecruitmentTool({
  tradeRole,
  amountUnit,
  amountInput,
  sellerPremiumInput,
  approximateKrw,
  approximateSats,
}: TradeRecruitmentToolProps) {
  const [network, setNetwork] = useState<TransferNetwork>("onchain");
  const [returningTraderEnabled, setReturningTraderEnabled] = useState(false);
  const [returningTraderPremiumInput, setReturningTraderPremiumInput] = useState("");
  const [canShareKrwSource, setCanShareKrwSource] = useState(false);
  const [canVerifyIdentity, setCanVerifyIdentity] = useState(false);
  const [memo, setMemo] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [copying, setCopying] = useState(false);

  const generated = useMemo(() => buildTradeRecruitmentPost({
    tradeRole,
    amountUnit,
    amountInput,
    sellerPremiumInput,
    approximateKrw,
    approximateSats,
    network,
    returningTraderEnabled,
    returningTraderPremiumInput,
    canShareKrwSource,
    canVerifyIdentity,
    memo,
  }), [
    amountInput,
    amountUnit,
    approximateKrw,
    approximateSats,
    canShareKrwSource,
    canVerifyIdentity,
    memo,
    network,
    returningTraderEnabled,
    returningTraderPremiumInput,
    sellerPremiumInput,
    tradeRole,
  ]);
  const structuredKey = useMemo(() => JSON.stringify({
    tradeRole,
    amountUnit,
    amountInput,
    sellerPremiumInput,
    network,
    returningTraderEnabled,
    returningTraderPremiumInput,
    canShareKrwSource,
    canVerifyIdentity,
    memo,
  }), [
    amountInput,
    amountUnit,
    canShareKrwSource,
    canVerifyIdentity,
    memo,
    network,
    returningTraderEnabled,
    returningTraderPremiumInput,
    sellerPremiumInput,
    tradeRole,
  ]);
  const [previewText, setPreviewText] = useState(generated.text);
  const [previewDirty, setPreviewDirty] = useState(false);
  const previousGeneratedRef = useRef(generated.text);
  const previousStructuredKeyRef = useRef(structuredKey);
  const returningPremiumInvalid = returningTraderEnabled
    && generated.error.startsWith("기존 거래자");

  useEffect(() => {
    const structuredChanged = previousStructuredKeyRef.current !== structuredKey;
    const next = syncTradeRecruitmentPreview({
      preview: previewText,
      previousGenerated: previousGeneratedRef.current,
      nextGenerated: generated.text,
      force: structuredChanged,
    });
    previousGeneratedRef.current = generated.text;
    previousStructuredKeyRef.current = structuredKey;
    if (next.preview !== previewText) setPreviewText(next.preview);
    if (next.dirty !== previewDirty) setPreviewDirty(next.dirty);
    setCopyStatus("");
  }, [generated.text, previewDirty, previewText, structuredKey]);

  function regeneratePreview() {
    const next = syncTradeRecruitmentPreview({
      preview: previewText,
      previousGenerated: previousGeneratedRef.current,
      nextGenerated: generated.text,
      force: true,
    });
    previousGeneratedRef.current = generated.text;
    setPreviewText(next.preview);
    setPreviewDirty(next.dirty);
    setCopyStatus("");
  }

  async function copyPreview() {
    if (copying) return;
    setCopying(true);
    setCopyStatus("");
    const clipboardWrite = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : null;
    const outcome = await copyTradeRecruitmentText(previewText, clipboardWrite, legacyCopy);
    setCopying(false);
    setCopyStatus(outcome === "copied"
      ? "모집글을 복사했습니다."
      : outcome === "empty"
        ? "복사할 모집글을 입력하세요."
        : "자동 복사하지 못했습니다. 미리보기에서 직접 선택해 복사하세요.");
  }

  return (
    <section className="trade-recruitment" aria-labelledby="trade-recruitment-title">
      <header className="recruitment-heading">
        <div>
          <p className="section-label">공개 채널용 · v1</p>
          <h2 id="trade-recruitment-title">거래 모집글 만들기</h2>
        </div>
        <a href="#trade-amount">거래 조건 수정 ↑</a>
      </header>
      <p className="recruitment-intro">
        입력한 금액은 확정 기준으로, 다른 단위는 현재 시세의 약값으로 표시합니다.
      </p>

      <form className="recruitment-form" onSubmit={(event) => event.preventDefault()}>
        <fieldset className="recruitment-network">
          <legend>BTC 전송 방식</legend>
          <div>
            {([
              ["onchain", "온체인"],
              ["lightning", "라이트닝"],
              ["both", "둘 다"],
            ] as const).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="recruitment-network"
                  value={value}
                  checked={network === value}
                  onChange={() => setNetwork(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <details className="recruitment-options">
          <summary>
            선택 문구 추가
            <small>{[returningTraderEnabled, tradeRole === "buyer" && canShareKrwSource, canVerifyIdentity].filter(Boolean).length
              ? `${[returningTraderEnabled, tradeRole === "buyer" && canShareKrwSource, canVerifyIdentity].filter(Boolean).length}개 선택`
              : "여러 개 선택 가능"}</small>
          </summary>
          <div className="recruitment-option-list">
            <label className="recruitment-check">
              <input
                type="checkbox"
                checked={returningTraderEnabled}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setReturningTraderEnabled(checked);
                  if (checked && !returningTraderPremiumInput) {
                    setReturningTraderPremiumInput(suggestedReturningPremium(sellerPremiumInput));
                  }
                }}
              />
              <span>기존 거래자 우대 프리미엄</span>
            </label>
            {returningTraderEnabled ? (
              <label className="returning-premium" htmlFor="returning-trader-premium">
                <span>기존 거래자 프리미엄</span>
                <span className="input-with-unit">
                  <input
                    id="returning-trader-premium"
                    inputMode="decimal"
                    value={returningTraderPremiumInput}
                    onChange={(event) => setReturningTraderPremiumInput(signedDecimalOnly(event.target.value))}
                    aria-describedby={returningPremiumInvalid ? "recruitment-error" : undefined}
                    aria-invalid={returningPremiumInvalid || undefined}
                  />
                  <b aria-hidden="true">%</b>
                </span>
              </label>
            ) : null}
            {tradeRole === "buyer" ? (
              <label className="recruitment-check">
                <input
                  type="checkbox"
                  checked={canShareKrwSource}
                  onChange={(event) => setCanShareKrwSource(event.target.checked)}
                />
                <span>원화 출처 설명 가능</span>
              </label>
            ) : null}
            <label className="recruitment-check">
              <input
                type="checkbox"
                checked={canVerifyIdentity}
                onChange={(event) => setCanVerifyIdentity(event.target.checked)}
              />
              <span>상호 신원확인 협의 가능</span>
            </label>
          </div>
        </details>

        <label className="recruitment-memo" htmlFor="recruitment-memo">
          <span>추가 조건·메모 <small>선택 사항</small></span>
          <textarea
            id="recruitment-memo"
            value={memo}
            maxLength={300}
            rows={3}
            placeholder="예: 답변이 늦을 수 있습니다. 첫 거래자는 활동 내역을 확인합니다."
            onChange={(event) => setMemo(event.target.value)}
          />
        </label>
      </form>

      <p className="recruitment-privacy-note">
        공개 모집에는 실제 자금 출처 종류·주소·인보이스·QR·지급 요청을 넣지 마세요. 필요한 정보는 상대방과 DM에서 확인하세요.
      </p>

      <div className="recruitment-preview">
        <label htmlFor="recruitment-preview">
          <span>편집 가능한 모집글 미리보기</span>
          <small>{previewDirty ? "직접 편집한 문구" : "입력값과 함께 자동 갱신"}</small>
        </label>
        <textarea
          id="recruitment-preview"
          value={previewText}
          rows={5}
          maxLength={2_000}
          aria-describedby={`${generated.error ? "recruitment-error " : ""}recruitment-copy-status`}
          aria-invalid={Boolean(generated.error) || undefined}
          onChange={(event) => {
            const value = event.target.value;
            setPreviewText(value);
            setPreviewDirty(value !== generated.text);
            setCopyStatus("");
          }}
        />
        {generated.error ? <p className="recruitment-error" id="recruitment-error" role="alert">{generated.error}</p> : null}
        <div className="recruitment-actions">
          <button type="button" onClick={regeneratePreview} disabled={!generated.text}>자동 문구로 되돌리기</button>
          <button type="button" className="recruitment-copy" onClick={() => void copyPreview()} disabled={!previewText.trim() || copying}>
            {copying ? "복사 중" : "모집글 텍스트 복사"}
          </button>
        </div>
        <p
          className={`recruitment-copy-status ${copyStatus.includes("못") ? "is-error" : ""}`}
          id="recruitment-copy-status"
          aria-live="polite"
        >
          {copyStatus}
        </p>
      </div>
    </section>
  );
}
