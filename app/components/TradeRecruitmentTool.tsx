"use client";

import { memo, type ReactNode, useMemo, useState } from "react";
import {
  buildTradeRecruitmentPost,
  shareTradeRecruitmentText,
  syncTradeRecruitmentPreview,
} from "../lib/trade-recruitment.mjs";
import { stepPremiumPercent } from "../lib/p2p-quote.mjs";

type TradeRole = "buyer" | "seller";
type AmountUnit = "krw" | "sats" | "btc";
type TransferNetwork = "onchain" | "lightning" | "both";

type TradeRecruitmentToolProps = {
  active: boolean;
  tradeRole: TradeRole;
  amountUnit: AmountUnit;
  amountInput: string;
  sellerPremiumInput: string;
  approximateKrw: number | null;
  approximateSats: number | null;
  bitcoinDisplayUnit: "sats" | "btc";
};

type RecruitmentPost = {
  text: string;
  error: string;
};

type RecruitmentPreviewProps = {
  generated: RecruitmentPost;
  customizationSummary: string;
  children: ReactNode;
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
  document.body.appendChild(textarea);
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

function RecruitmentPreview({ generated, customizationSummary, children }: RecruitmentPreviewProps) {
  const [previewState, setPreviewState] = useState(() => ({
    preview: generated.text,
    generatedText: generated.text,
  }));
  const [copyFeedback, setCopyFeedback] = useState<{
    generatedText: string;
    previewText: string;
    message: string;
  } | null>(null);
  const [sharing, setSharing] = useState(false);
  const syncedPreview = syncTradeRecruitmentPreview({
    preview: previewState.preview,
    previousGenerated: previewState.generatedText,
    nextGenerated: generated.text,
  });
  const previewText = syncedPreview.preview;
  const previewDirty = syncedPreview.dirty;
  const copyStatus = copyFeedback?.generatedText === generated.text
    && copyFeedback.previewText === previewText
    ? copyFeedback.message
    : "";

  function regeneratePreview() {
    setPreviewState({
      preview: generated.text,
      generatedText: generated.text,
    });
    setCopyFeedback(null);
  }

  async function sharePreview() {
    if (sharing) return;
    const feedbackContext = {
      generatedText: generated.text,
      previewText,
    };
    setSharing(true);
    setCopyFeedback(null);
    const nativeShare = navigator.share
      ? (value: string) => navigator.share({ title: "비트코인 P2P 거래 모집", text: value })
      : null;
    const clipboardWrite = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : null;
    const outcome = await shareTradeRecruitmentText(previewText, nativeShare, clipboardWrite, legacyCopy);
    setSharing(false);
    const message = outcome === "shared"
      ? "모집글을 공유했습니다."
      : outcome === "copied"
        ? "공유 기능을 지원하지 않아 모집글을 복사했습니다."
        : outcome === "empty"
          ? "공유할 모집글을 입력하세요."
          : outcome === "cancelled"
            ? "공유를 취소했습니다."
            : "자동 복사하지 못했습니다. 미리보기에서 직접 선택해 복사하세요.";
    setCopyFeedback({ ...feedbackContext, message });
  }

  return (
    <div className="recruitment-preview">
      <div className="recruitment-preview-heading">
        <span>모집글 미리보기</span>
        <small>{previewDirty ? "직접 편집한 문구" : "입력값과 함께 자동 갱신"}</small>
      </div>
      <pre className="recruitment-preview-text" aria-label="공유할 거래 모집글">
        {previewText || "거래 조건을 입력하면 모집글이 표시됩니다."}
      </pre>
      {generated.error ? <p className="recruitment-error" id="recruitment-error" role="alert">{generated.error}</p> : null}
      <div className="recruitment-actions">
        <button type="button" className="recruitment-copy" onClick={() => void sharePreview()} disabled={!previewText.trim() || sharing}>
          {sharing ? "공유 중" : "모집글 공유"}
        </button>
      </div>
      <p
        className={`recruitment-copy-status ${copyStatus.includes("못") ? "is-error" : ""}`}
        id="recruitment-copy-status"
        aria-live="polite"
      >
        {copyStatus}
      </p>
      <details className="recruitment-customization">
        <summary>
          모집글 세부 설정
          <small>{generated.error ? "입력 확인" : previewDirty ? "직접 수정됨" : customizationSummary}</small>
        </summary>
        <div className="recruitment-customization-body">
          {children}
          <label className="recruitment-editor" htmlFor="recruitment-preview">
            <span>모집글 직접 편집 <small>선택 사항</small></span>
            <textarea
              id="recruitment-preview"
              value={previewText}
              rows={5}
              maxLength={2_000}
              aria-describedby={`${generated.error ? "recruitment-error " : ""}recruitment-copy-status`}
              aria-invalid={Boolean(generated.error) || undefined}
              onChange={(event) => {
                setPreviewState({
                  preview: event.target.value,
                  generatedText: generated.text,
                });
                setCopyFeedback(null);
              }}
            />
          </label>
          <button className="recruitment-reset" type="button" onClick={regeneratePreview} disabled={!generated.text}>
            자동 문구로 되돌리기
          </button>
        </div>
      </details>
    </div>
  );
}

function TradeRecruitmentToolComponent({
  tradeRole,
  amountUnit,
  amountInput,
  sellerPremiumInput,
  approximateKrw,
  approximateSats,
  bitcoinDisplayUnit,
}: TradeRecruitmentToolProps) {
  const [network, setNetwork] = useState<TransferNetwork>("onchain");
  const [returningTraderEnabled, setReturningTraderEnabled] = useState(false);
  const [returningTraderPremiumOverride, setReturningTraderPremiumInput] = useState<string | null>(null);
  const [canShareKrwSource, setCanShareKrwSource] = useState(false);
  const [canVerifyIdentity, setCanVerifyIdentity] = useState(false);
  const [memoText, setMemo] = useState("");
  const returningTraderPremiumInput = returningTraderPremiumOverride
    ?? suggestedReturningPremium(sellerPremiumInput);
  const returningPremiumPercent = returningTraderPremiumInput === "" || returningTraderPremiumInput === "-"
    ? null
    : Number(returningTraderPremiumInput);

  const generated = useMemo(() => buildTradeRecruitmentPost({
    tradeRole,
    amountUnit,
    amountInput,
    sellerPremiumInput,
    approximateKrw,
    approximateSats,
    bitcoinDisplayUnit,
    network,
    returningTraderEnabled,
    returningTraderPremiumInput,
    canShareKrwSource,
    canVerifyIdentity,
    memo: memoText,
  }), [
    amountInput,
    amountUnit,
    approximateKrw,
    approximateSats,
    bitcoinDisplayUnit,
    canShareKrwSource,
    canVerifyIdentity,
    memoText,
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
    bitcoinDisplayUnit,
    network,
    returningTraderEnabled,
    returningTraderPremiumInput,
    canShareKrwSource,
    canVerifyIdentity,
    memo: memoText,
  }), [
    amountInput,
    amountUnit,
    canShareKrwSource,
    canVerifyIdentity,
    memoText,
    network,
    returningTraderEnabled,
    returningTraderPremiumInput,
    sellerPremiumInput,
    bitcoinDisplayUnit,
    tradeRole,
  ]);
  const returningPremiumInvalid = returningTraderEnabled
    && generated.error.startsWith("기존 거래자");
  const customizationCount = [
    returningTraderEnabled,
    tradeRole === "buyer" && canShareKrwSource,
    canVerifyIdentity,
    Boolean(memoText.trim()),
  ].filter(Boolean).length;
  const customizationSummary = customizationCount ? `${customizationCount}개 추가` : "선택 사항";

  function adjustReturningPremium(direction: -1 | 1) {
    const current = Number.isFinite(returningPremiumPercent) ? returningPremiumPercent : null;
    const next = stepPremiumPercent(current, direction);
    if (next !== null) setReturningTraderPremiumInput(String(next));
  }

  return (
    <section className="trade-recruitment" aria-labelledby="trade-recruitment-title">
      <header className="recruitment-heading">
        <div>
          <p className="section-label">공개 채널용</p>
          <h2 id="trade-recruitment-title">거래 모집글 만들기</h2>
        </div>
        <a href="#trade-amount">거래 조건 수정 ↑</a>
      </header>
      <p className="recruitment-intro">
        입력한 금액은 확정 기준으로, 다른 단위는 시세 기준 약값으로 표시합니다.
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

        <RecruitmentPreview
          key={structuredKey}
          generated={generated}
          customizationSummary={customizationSummary}
        >
          <fieldset className="recruitment-option-group">
            <legend>
              선택 문구 추가
              <small>여러 개 선택 가능</small>
            </legend>
            <div className="recruitment-option-list">
              <div className="returning-option">
                <label className="recruitment-check">
                  <input
                    type="checkbox"
                    checked={returningTraderEnabled}
                    aria-controls="returning-trader-premium-field"
                    aria-expanded={returningTraderEnabled}
                    onChange={(event) => setReturningTraderEnabled(event.target.checked)}
                  />
                  <span>기존 거래자 우대</span>
                </label>
                {returningTraderEnabled ? (
                  <label
                    className="returning-premium"
                    htmlFor="returning-trader-premium"
                    id="returning-trader-premium-field"
                  >
                    <span className="input-with-unit">
                      <input
                        id="returning-trader-premium"
                        inputMode="decimal"
                        value={returningTraderPremiumInput}
                        onChange={(event) => setReturningTraderPremiumInput(signedDecimalOnly(event.target.value))}
                        aria-label="기존 거래자 우대 프리미엄"
                        aria-describedby={returningPremiumInvalid ? "recruitment-error" : undefined}
                        aria-invalid={returningPremiumInvalid || undefined}
                      />
                      <span className="premium-stepper" role="group" aria-label="기존 거래자 우대 프리미엄 0.1% 단위 조절">
                        <b aria-hidden="true">%</b>
                        <button
                          type="button"
                          onClick={() => adjustReturningPremium(1)}
                          aria-label="기존 거래자 우대 프리미엄 0.1% 올리기"
                          title="0.1% 올리기"
                        >
                          <span aria-hidden="true">▲</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => adjustReturningPremium(-1)}
                          disabled={returningPremiumPercent !== null && returningPremiumPercent <= -99.99}
                          aria-label="기존 거래자 우대 프리미엄 0.1% 내리기"
                          title="0.1% 내리기"
                        >
                          <span aria-hidden="true">▼</span>
                        </button>
                      </span>
                    </span>
                  </label>
                ) : null}
              </div>
              {tradeRole === "buyer" ? (
                <label className="recruitment-check">
                  <input
                    type="checkbox"
                    checked={canShareKrwSource}
                    onChange={(event) => setCanShareKrwSource(event.target.checked)}
                  />
                  <span>원화 자금 출처 설명 가능</span>
                </label>
              ) : null}
              <label className="recruitment-check">
                <input
                  type="checkbox"
                  checked={canVerifyIdentity}
                  onChange={(event) => setCanVerifyIdentity(event.target.checked)}
                />
                <span>거래 전 상호 신원 확인 가능</span>
              </label>
            </div>
          </fieldset>

          <label className="recruitment-memo" htmlFor="recruitment-memo">
            <span>추가 조건·메모 <small>선택 사항</small></span>
            <textarea
              id="recruitment-memo"
              value={memoText}
              maxLength={300}
              rows={3}
              placeholder="예: 답변이 늦을 수 있습니다. 첫 거래자는 활동 내역을 확인합니다."
              onChange={(event) => setMemo(event.target.value)}
            />
          </label>
        </RecruitmentPreview>
      </form>
    </section>
  );
}

function recruitmentPropsEqual(
  previous: TradeRecruitmentToolProps,
  next: TradeRecruitmentToolProps,
) {
  if (previous.active !== next.active) return false;
  if (!next.active) return true;
  return previous.tradeRole === next.tradeRole
    && previous.amountUnit === next.amountUnit
    && previous.amountInput === next.amountInput
    && previous.sellerPremiumInput === next.sellerPremiumInput
    && previous.approximateKrw === next.approximateKrw
    && previous.approximateSats === next.approximateSats
    && previous.bitcoinDisplayUnit === next.bitcoinDisplayUnit;
}

export const TradeRecruitmentTool = memo(TradeRecruitmentToolComponent, recruitmentPropsEqual);
