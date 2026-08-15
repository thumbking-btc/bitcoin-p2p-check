"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { MAX_BOLT11_LENGTH, validateBolt11Invoice } from "../lib/bolt11-invoice.mjs";
import { createPrivateRequestImage } from "../lib/private-request-image";
import { formatSatsAsBtcAmount } from "../lib/p2p-receive-request.mjs";
import { isReferenceShareable, shareSensitiveImageFile } from "../lib/share-transport.mjs";
import { createVerifiedTextQr } from "../lib/verified-qr.mjs";

type Props = {
  fundingSource: string;
  paymentKrw: number | null;
  quoteCurrent: boolean;
  quoteKey: string;
  referenceTime: string | null;
  sats: number | null;
};

type Snapshot = {
  expiresAt: number;
  paymentKrw: number;
  quoteKey: string;
  sats: number;
};

type Artifact = {
  invoice: {
    amountMsat: bigint;
    canonicalInvoice: string;
    expiresAt: number;
    payeeNodeId: string;
  };
  privateImage: File;
  qr: {
    data: Uint8ClampedArray;
    height: number;
    payload: string;
    width: number;
  };
  source: {
    expiresAt: number;
    fundingSource: string;
    paymentKrw: number;
    quoteKey: string;
    sats: number;
  };
};

const REQUEST_LIFETIME_MS = 10 * 60_000;

function formatKrw(value: number) {
  return `${value.toLocaleString("ko-KR")}원`;
}

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

function isPlausibleInvoiceDraft(value: string) {
  if (!value) return true;
  if (value.length > MAX_BOLT11_LENGTH || /\s/u.test(value) || !/^[a-z0-9:]+$/iu.test(value)) return false;
  const lower = value.toLowerCase();
  if ("lnbc".startsWith(lower) || "lightning:lnbc".startsWith(lower)) return true;
  return lower.startsWith("lnbc") || lower.startsWith("lightning:lnbc");
}

export function P2PLightningRequest({ fundingSource, paymentKrw, quoteCurrent, quoteKey, referenceTime, sats }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [invoiceInput, setInvoiceInput] = useState("");
  const [invoiceConfirmed, setInvoiceConfirmed] = useState(false);
  const [amountConfirmed, setAmountConfirmed] = useState(false);
  const [externalShareConfirmed, setExternalShareConfirmed] = useState(false);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [feedback, setFeedback] = useState("");
  const [failure, setFailure] = useState("");
  const [sharingPrivateImage, setSharingPrivateImage] = useState(false);
  const artifactRef = useRef<Artifact | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const clearArtifactSurface = useCallback(() => {
    generationRef.current += 1;
    artifactRef.current?.qr.data.fill(0);
    artifactRef.current = null;
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    if (resultRef.current) resultRef.current.hidden = true;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const clearArtifact = useCallback(() => {
    clearArtifactSurface();
    setArtifact(null);
  }, [clearArtifactSurface]);

  const clearNativeInput = useCallback(() => {
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const clearSensitive = useCallback((keepSnapshot = true) => {
    clearArtifact();
    clearNativeInput();
    setInvoiceInput("");
    setInvoiceConfirmed(false);
    setAmountConfirmed(false);
    setExternalShareConfirmed(false);
    setSharingPrivateImage(false);
    setFeedback("");
    setFailure("");
    if (!keepSnapshot) setSnapshot(null);
  }, [clearArtifact, clearNativeInput]);

  useEffect(() => {
    if (!snapshot) return;
    const timeout = window.setTimeout(() => {
      clearSensitive(false);
      setFailure("고정한 거래 조건이 만료되었습니다. 현재 조건을 다시 확인해 주세요.");
    }, Math.max(0, snapshot.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [snapshot, clearSensitive]);

  useEffect(() => {
    if (!artifact) return;
    const timeout = window.setTimeout(() => {
      clearSensitive(false);
      setFailure("라이트닝 인보이스가 만료되었습니다. 지갑에서 새 인보이스를 만들어 주세요.");
    }, Math.max(0, artifact.source.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [artifact, clearSensitive]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") clearSensitive(true);
    };
    const handlePageHide = () => clearSensitive(true);
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) clearSensitive(true);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [clearSensitive]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearNativeInput();
      clearArtifactSurface();
    };
  }, [clearArtifactSurface, clearNativeInput]);

  useLayoutEffect(() => {
    if (!artifact || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = artifact.qr.width;
    canvas.height = artifact.qr.height;
    const context = canvas.getContext("2d");
    if (!context) {
      clearArtifactSurface();
      setArtifact(null);
      setFailure("QR을 화면에 표시하지 못했습니다. 다시 만들어 주세요.");
      return;
    }
    const pixels = context.createImageData(artifact.qr.width, artifact.qr.height);
    pixels.data.set(artifact.qr.data);
    context.imageSmoothingEnabled = false;
    context.putImageData(pixels, 0, 0);
    pixels.data.fill(0);
    if (resultRef.current) resultRef.current.hidden = false;
  }, [artifact, clearArtifactSurface]);

  const canStart = useMemo(
    () => quoteCurrent
      && Number.isSafeInteger(sats)
      && Number(sats) > 0
      && Number.isSafeInteger(paymentKrw)
      && Number(paymentKrw) > 0,
    [paymentKrw, quoteCurrent, sats],
  );

  function startRequest() {
    if (!canStart || !isReferenceShareable({ marketState: quoteCurrent ? "ready" : "error", referenceTime }, Date.now()) || sats === null || paymentKrw === null) {
      clearSensitive(false);
      setFailure("시세가 5분 이상 지났습니다. 새 시세를 확인한 뒤 다시 시작해 주세요.");
      return;
    }
    clearSensitive(false);
    setSnapshot({ expiresAt: Date.now() + REQUEST_LIFETIME_MS, paymentKrw, quoteKey, sats });
    setFeedback("현재 거래 조건을 10분 동안 고정했습니다. 내 라이트닝 지갑에서 이 금액의 새 인보이스를 만드세요.");
  }

  function changeInvoice(next: string) {
    if (!isPlausibleInvoiceDraft(next)) {
      clearSensitive(true);
      setFailure("BOLT11 인보이스가 아닌 입력은 보관하지 않습니다. 복구문구·개인키·LNURL·Lightning Address를 넣지 마세요.");
      return;
    }
    clearArtifact();
    setInvoiceInput(next);
    setInvoiceConfirmed(false);
    setAmountConfirmed(false);
    setExternalShareConfirmed(false);
    setFeedback("");
    setFailure("");
  }

  async function buildRequest() {
    if (!snapshot || snapshot.quoteKey !== quoteKey || Date.now() >= snapshot.expiresAt) {
      clearSensitive(false);
      setFailure("거래 조건이 바뀌거나 만료되었습니다. 현재 조건을 다시 고정해 주세요.");
      return;
    }
    if (!invoiceConfirmed || !amountConfirmed) {
      setFailure("내 지갑의 새 인보이스와 정확한 사토시를 직접 확인해 주세요.");
      return;
    }
    clearArtifact();
    const generation = generationRef.current;
    let qr: Artifact["qr"] | null = null;
    try {
      const invoice = validateBolt11Invoice(invoiceInput, {
        expectedSats: BigInt(snapshot.sats),
        minimumRemainingSeconds: 60,
      });
      const expiresAt = Math.min(snapshot.expiresAt, invoice.expiresAt * 1_000);
      const payload = invoice.canonicalInvoice.toUpperCase();
      qr = createVerifiedTextQr(payload, { maximumLength: MAX_BOLT11_LENGTH, maximumPixelSize: 580, level: "M" });
      const privateImage = await createPrivateRequestImage({
        rail: "lightning",
        invoice: invoice.canonicalInvoice,
        sats: snapshot.sats,
        paymentKrw: snapshot.paymentKrw,
        fundingSource,
        validUntil: expiresAt,
      });
      if (!mountedRef.current || generationRef.current !== generation || snapshot.quoteKey !== quoteKey || Date.now() >= expiresAt) {
        qr.data.fill(0);
        return;
      }
      const nextArtifact: Artifact = {
        invoice,
        privateImage,
        qr,
        source: { expiresAt, fundingSource, paymentKrw: snapshot.paymentKrw, quoteKey: snapshot.quoteKey, sats: snapshot.sats },
      };
      artifactRef.current = nextArtifact;
      setArtifact(nextArtifact);
      setFailure("");
      setFeedback("인보이스 서명·메인넷·금액·만료와 생성한 QR 원문을 로컬에서 다시 확인했습니다.");
    } catch (error) {
      qr?.data.fill(0);
      clearArtifact();
      if (!mountedRef.current) return;
      setFeedback("");
      setFailure(error instanceof Error ? error.message : "라이트닝 요청을 만들지 못했습니다.");
    }
  }

  function artifactIsUsable(candidate: Artifact | null): candidate is Artifact {
    return Boolean(
      candidate
      && artifactRef.current === candidate
      && candidate.source.quoteKey === quoteKey
      && candidate.source.fundingSource === fundingSource
      && BigInt(candidate.source.sats) * BigInt(1_000) === candidate.invoice.amountMsat
      && Date.now() < candidate.source.expiresAt,
    );
  }

  function buildPrivateText(candidate: Artifact) {
    return [
      "[1:1 BTC 송금 요청 · 라이트닝]",
      "판매자가 보내고 구매자가 받습니다.",
      `고정 원화 조건: ${formatKrw(candidate.source.paymentKrw)}`,
      `받을 금액: ${formatSats(candidate.source.sats)} (${formatSatsAsBtcAmount(BigInt(candidate.source.sats))} BTC)`,
      `구매자 자금 출처: ${candidate.source.fundingSource} (구매자 제공 정보)`,
      `상호 재확인 기한: ${formatExpiry(Math.floor(candidate.source.expiresAt / 1_000))}`,
      `인보이스 만료: ${formatExpiry(candidate.invoice.expiresAt)}`,
      "BOLT11:",
      candidate.invoice.canonicalInvoice,
      "라우팅 수수료: 판매자 지갑에서 결제 전 확인 · 구매자 수령액 차감 없음",
      "원화 선송금은 BTC 지급을 보장하지 않습니다.",
      "결제 완료는 구매자 수취 지갑에서 직접 확인하세요.",
      "확인용: 결제·입금 완료 증빙 아님",
    ].join("\n");
  }

  async function copyInvoice() {
    const candidate = artifact;
    if (!artifactIsUsable(candidate) || !navigator.clipboard?.writeText) {
      setFailure("현재 인보이스를 복사할 수 없습니다. 새 요청을 만들어 주세요.");
      return;
    }
    const generation = generationRef.current;
    try {
      await navigator.clipboard.writeText(candidate.invoice.canonicalInvoice);
      if (!mountedRef.current) return;
      if (generationRef.current !== generation || !artifactIsUsable(candidate)) {
        setFailure("요청이 바뀌는 동안 이전 인보이스가 복사되었을 수 있습니다. 복사한 내용은 사용하지 마세요.");
        return;
      }
      setFailure("");
      setFeedback("BOLT11 인보이스를 복사했습니다. 클립보드 동기화 설정을 확인하세요.");
    } catch {
      if (mountedRef.current) setFailure("BOLT11 인보이스를 복사하지 못했습니다.");
    }
  }

  async function copyPrivateText() {
    const candidate = artifact;
    if (!externalShareConfirmed) {
      setFailure("민감정보가 외부 앱이나 클립보드에 남을 수 있다는 내용을 먼저 확인해 주세요.");
      return;
    }
    if (!artifactIsUsable(candidate) || !navigator.clipboard?.writeText) {
      setFailure("현재 1:1 요청을 복사할 수 없습니다. 새 요청을 만들어 주세요.");
      return;
    }
    const generation = generationRef.current;
    try {
      await navigator.clipboard.writeText(buildPrivateText(candidate));
      if (!mountedRef.current) return;
      if (generationRef.current !== generation || !artifactIsUsable(candidate)) {
        setFailure("요청이 바뀌는 동안 이전 내용이 복사되었을 수 있습니다. 복사한 내용은 사용하지 마세요.");
        return;
      }
      setFailure("");
      setFeedback("인보이스·금액이 포함된 1:1 요청 텍스트를 복사했습니다. 공유 대상을 다시 확인하세요.");
    } catch {
      if (mountedRef.current) setFailure("1:1 요청 텍스트를 복사하지 못했습니다.");
    }
  }

  async function sharePrivateImage() {
    const candidate = artifact;
    if (!externalShareConfirmed) {
      setFailure("민감정보가 외부 앱에 남을 수 있다는 내용을 먼저 확인해 주세요.");
      return;
    }
    if (!artifactIsUsable(candidate) || sharingPrivateImage) {
      setFailure("현재 1:1 요청을 공유할 수 없습니다. 새 요청을 만들어 주세요.");
      return;
    }
    const generation = generationRef.current;
    setSharingPrivateImage(true);
    const outcome = await shareSensitiveImageFile({
      file: candidate.privateImage,
      title: "1:1 BTC 송금 요청 · 라이트닝",
      text: buildPrivateText(candidate),
      nativeShare: typeof navigator.share === "function" ? navigator.share.bind(navigator) : null,
      nativeCanShare: typeof navigator.canShare === "function" ? navigator.canShare.bind(navigator) : null,
    });
    if (!mountedRef.current) return;
    setSharingPrivateImage(false);
    if (generationRef.current !== generation || !artifactIsUsable(candidate)) return;
    if (outcome === "shared") setFeedback("공유 창으로 전달했습니다. 상대방 수신 여부는 확인할 수 없습니다.");
    else if (outcome === "cancelled") setFeedback("공유를 취소했습니다.");
    else if (outcome === "unsupported") setFailure("이 브라우저는 민감 이미지 파일 공유를 지원하지 않습니다. 텍스트 복사나 QR 저장을 사용하세요.");
    else setFailure("1:1 요청 이미지를 공유하지 못했습니다. 자동 저장은 하지 않았습니다.");
  }

  async function downloadQr() {
    const candidate = artifact;
    const canvas = canvasRef.current;
    if (!artifactIsUsable(candidate) || !canvas) {
      setFailure("현재 QR을 저장할 수 없습니다. 새 요청을 만들어 주세요.");
      return;
    }
    const generation = generationRef.current;
    try {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("png")), "image/png"));
      if (!mountedRef.current || generationRef.current !== generation || !artifactIsUsable(candidate)) return;
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = "bitcoin-lightning-request.png";
      try {
        document.body.appendChild(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        window.setTimeout(() => {
          if (objectUrlRef.current === objectUrl) objectUrlRef.current = null;
          URL.revokeObjectURL(objectUrl);
        }, 1_000);
      }
      setFailure("");
      setFeedback("QR PNG 다운로드를 시작했습니다. 다운로드 폴더와 클라우드 동기화 설정을 확인하세요.");
    } catch {
      if (mountedRef.current) setFailure("QR PNG를 만들지 못했습니다.");
    }
  }

  return (
    <section className="receive-request lightning-request" aria-labelledby="lightning-request-title">
      <header>
        <div>
          <p className="section-kicker">선택한 지급 방식</p>
          <h2 id="lightning-request-title">구매자 라이트닝 인보이스</h2>
        </div>
        <span>선택 기능 · 로컬 처리</span>
      </header>

      {!snapshot ? (
        <div className="receive-request-start">
          <p>계산 결과를 고정한 뒤, 구매자 자신의 라이트닝 지갑에서 정확한 금액이 든 새 BOLT11 인보이스를 만들어 붙여넣습니다.</p>
          <p className="receive-risk-warning"><b>원화를 먼저 보내더라도 BTC 지급이 보장되지는 않습니다.</b> 결제 완료는 구매자의 수취 지갑에서 직접 확인하세요.</p>
          {sats && paymentKrw ? (
            <dl>
              <div><dt>고정할 수취량</dt><dd>{formatSats(sats)}</dd></div>
              <div><dt>현재 원화 조건</dt><dd>{formatKrw(paymentKrw)}</dd></div>
            </dl>
          ) : null}
          <button type="button" onClick={startRequest} disabled={!canStart}>{quoteCurrent ? "현재 거래 조건으로 라이트닝 요청 시작" : "최신 시세 확인 후 시작"}</button>
          <p>Lightning Address·LNURL·BOLT12 offer가 아니라 이번 거래용 고정금액 BOLT11만 받습니다. 인보이스는 서버·URL·저장소·공개 모집물에 넣지 않습니다.</p>
        </div>
      ) : (
        <>
          <div className="receive-snapshot" role="note">
            <span>10분 고정 조건</span><strong>{formatSats(snapshot.sats)}</strong>
            <span>고정 원화 조건</span><strong>{formatKrw(snapshot.paymentKrw)}</strong>
            <small>라우팅 수수료는 판매자가 결제 전 확인 · 구매자 수령량에서 차감하지 않음</small>
          </div>
          <label className="lightning-invoice-field" htmlFor="p2p-lightning-invoice">
            <span>내 지갑의 새 고정금액 BOLT11 인보이스</span>
            <textarea
              ref={inputRef}
              id="p2p-lightning-invoice"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={invoiceInput}
              onChange={(event) => changeInvoice(event.target.value)}
              placeholder="lnbc…"
              aria-describedby="p2p-lightning-invoice-note"
            />
          </label>
          <p id="p2p-lightning-invoice-note" className="receive-address-note">복구문구·개인키·payment preimage는 절대 넣지 마세요. 메인넷·정확한 금액·서명·만료를 이 브라우저에서만 확인합니다.</p>
          <div className="receive-confirmations">
            <label>
              <input type="checkbox" checked={invoiceConfirmed} onChange={(event) => { clearArtifact(); setInvoiceConfirmed(event.target.checked); if (!event.target.checked) setAmountConfirmed(false); }} disabled={!invoiceInput} />
              <span>나는 BTC를 받을 구매자이며, 내 라이트닝 지갑에서 이번 거래용으로 새로 만든 <b>고정금액 BOLT11 인보이스</b>입니다.</span>
            </label>
            <label>
              <input type="checkbox" checked={amountConfirmed} onChange={(event) => { clearArtifact(); setAmountConfirmed(event.target.checked); }} disabled={!invoiceConfirmed} />
              <span>인보이스 금액이 <b>{formatSats(snapshot.sats)}</b>와 정확히 같고 라우팅 수수료는 판매자가 별도로 부담합니다.</span>
            </label>
          </div>
          <div className="receive-actions">
            <button type="button" onClick={() => void buildRequest()} disabled={!invoiceInput || !invoiceConfirmed || !amountConfirmed}>인보이스·금액 QR 만들기</button>
            <button type="button" className="is-secondary" onClick={() => clearSensitive(false)}>모두 지우기</button>
          </div>

          {artifact ? (
            <div ref={resultRef} className="receive-artifact">
              <div className="receive-proof">
                <span>로컬 서명·QR 재검증 완료</span>
                <strong>{formatSats(artifact.source.sats)}</strong>
                <dl>
                  <div><dt>상호 재확인 기한</dt><dd>{formatExpiry(Math.floor(artifact.source.expiresAt / 1_000))}</dd></div>
                  <div><dt>인보이스 만료</dt><dd>{formatExpiry(artifact.invoice.expiresAt)}</dd></div>
                  <div><dt>수취 노드</dt><dd><code dir="ltr">{artifact.invoice.payeeNodeId}</code></dd></div>
                </dl>
                <details className="lightning-invoice-details">
                  <summary>전체 BOLT11 보기</summary>
                  <code dir="ltr">{artifact.invoice.canonicalInvoice}</code>
                </details>
              </div>
              <canvas ref={canvasRef} className="receive-qr" role="img" aria-label={`${artifact.source.sats} sats 라이트닝 인보이스 QR`} />
              <p>인보이스 복사·QR 저장·1:1 공유 후에는 운영체제와 선택한 앱의 보관·동기화 정책이 적용되며 사이트에서 회수할 수 없습니다.</p>
              <label className="receive-external-confirmation">
                <input type="checkbox" checked={externalShareConfirmed} onChange={(event) => setExternalShareConfirmed(event.target.checked)} />
                <span>1:1 이미지와 텍스트에는 전체 인보이스·금액·자금 출처가 포함되며, 공유 후 외부 앱에 남고 회수되지 않을 수 있음을 확인했습니다.</span>
              </label>
              <div className="receive-export-actions">
                <button type="button" onClick={() => void copyPrivateText()} disabled={!externalShareConfirmed}>1:1 요청 텍스트 복사</button>
                <button type="button" onClick={() => void sharePrivateImage()} disabled={!externalShareConfirmed || sharingPrivateImage}>{sharingPrivateImage ? "공유 창 여는 중" : "1:1 요청 이미지 공유"}</button>
                <button type="button" onClick={() => void copyInvoice()}>BOLT11 인보이스 복사</button>
                <button type="button" onClick={() => void downloadQr()}>QR PNG 저장</button>
              </div>
              <p>라이트닝 요청은 결제 완료 증빙이 아닙니다. 실제 수취 여부는 구매자 지갑에서 확인하고, 만료되면 새 인보이스로 다시 합의하세요.</p>
            </div>
          ) : null}
        </>
      )}

      <p className="receive-feedback" aria-live="polite" role={failure ? "alert" : undefined}>{failure || feedback}</p>
    </section>
  );
}
