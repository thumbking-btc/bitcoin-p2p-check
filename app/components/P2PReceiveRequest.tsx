"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  P2PReceiveRequestError,
  assertP2PReceiveAddressInputSafe,
  createP2PReceiveRequest,
  createVerifiedP2PReceiveQr,
} from "../lib/p2p-receive-request.mjs";

type Props = {
  isBuyer: boolean;
  quoteCurrent: boolean;
  quoteKey: string;
  paymentKrw: number | null;
  sats: number | null;
};

type Snapshot = {
  expiresAt: number;
  paymentKrw: number;
  quoteKey: string;
  sats: number;
};

type Artifact = {
  qr: {
    data: Uint8ClampedArray;
    height: number;
    payload: string;
    width: number;
  };
  request: {
    address: string;
    btcAmount: string;
    sats: string;
    scriptType: string;
    uri: string;
  };
  source: {
    address: string;
    expiresAt: number;
    quoteKey: string;
    sats: number;
  };
};

const REQUEST_LIFETIME_MS = 10 * 60_000;
const SCRIPT_LABELS: Record<string, string> = {
  p2pkh: "Legacy (P2PKH)",
  p2sh: "Script Hash (P2SH)",
  p2wpkh: "Native SegWit (P2WPKH)",
  p2wsh: "Native SegWit (P2WSH)",
  p2tr: "Taproot (P2TR)",
};

function formatKrw(value: number) {
  return value.toLocaleString("ko-KR") + "원";
}

function formatSats(value: number) {
  return value.toLocaleString("ko-KR") + " sats";
}

export function P2PReceiveRequest({
  isBuyer,
  quoteCurrent,
  quoteKey,
  paymentKrw,
  sats,
}: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [addressConfirmed, setAddressConfirmed] = useState(false);
  const [amountConfirmed, setAmountConfirmed] = useState(false);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [feedback, setFeedback] = useState("");
  const [failure, setFailure] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const artifactRef = useRef<Artifact | null>(null);
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

  const clearNativeAddressInput = useCallback(() => {
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const clearSensitive = useCallback((keepSnapshot = true) => {
    clearArtifact();
    clearNativeAddressInput();
    setAddressInput("");
    setAddressConfirmed(false);
    setAmountConfirmed(false);
    setFeedback("");
    setFailure("");
    if (!keepSnapshot) setSnapshot(null);
  }, [clearArtifact, clearNativeAddressInput]);

  useEffect(() => {
    if (!snapshot) return;
    const remaining = snapshot.expiresAt - Date.now();
    const timeout = window.setTimeout(() => {
      clearSensitive(false);
      setFailure("고정한 거래 조건이 만료되었습니다. 현재 조건을 다시 확인해 주세요.");
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timeout);
  }, [snapshot, clearSensitive]);

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
      clearNativeAddressInput();
      clearArtifactSurface();
    };
  }, [clearArtifactSurface, clearNativeAddressInput]);

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
    context.imageSmoothingEnabled = false;
    const canvasImage = context.createImageData(artifact.qr.width, artifact.qr.height);
    canvasImage.data.set(artifact.qr.data);
    context.putImageData(canvasImage, 0, 0);
    canvasImage.data.fill(0);
    if (resultRef.current) resultRef.current.hidden = false;
  }, [artifact, clearArtifactSurface]);

  const canStart = useMemo(
    () => isBuyer
      && quoteCurrent
      && Number.isSafeInteger(sats)
      && Number(sats) > 0
      && Number.isSafeInteger(paymentKrw)
      && Number(paymentKrw) > 0,
    [isBuyer, paymentKrw, quoteCurrent, sats],
  );

  function startRequest() {
    if (!canStart || sats === null || paymentKrw === null) return;
    clearSensitive(false);
    setSnapshot({
      expiresAt: Date.now() + REQUEST_LIFETIME_MS,
      paymentKrw,
      quoteKey,
      sats,
    });
    setFeedback("현재 거래 조건을 10분 동안 고정했습니다. 지갑에서 새 수취 주소를 확인하세요.");
  }

  function changeAddress(next: string) {
    try {
      assertP2PReceiveAddressInputSafe(next);
    } catch (error) {
      clearSensitive(true);
      setFailure(error instanceof Error ? error.message : "비밀정보처럼 보이는 입력을 지웠습니다.");
      return;
    }
    clearArtifact();
    setAddressInput(next.slice(0, 90));
    setAddressConfirmed(false);
    setAmountConfirmed(false);
    setFeedback("");
    setFailure("");
  }

  function buildRequest() {
    if (!snapshot || snapshot.quoteKey !== quoteKey || Date.now() >= snapshot.expiresAt) {
      clearSensitive(false);
      setFailure("거래 조건이 바뀌거나 만료되었습니다. 현재 조건을 다시 고정해 주세요.");
      return;
    }
    if (!addressConfirmed || !amountConfirmed) {
      setFailure("전체 주소와 정확한 사토시를 직접 확인해 주세요.");
      return;
    }

    try {
      const request = createP2PReceiveRequest({
        address: addressInput,
        addressConfirmed: true,
        amountConfirmed: true,
        sats: BigInt(snapshot.sats),
      });
      const qr = createVerifiedP2PReceiveQr(request);
      clearArtifact();
      const nextArtifact = {
        request,
        qr,
        source: {
          address: request.address,
          expiresAt: snapshot.expiresAt,
          quoteKey: snapshot.quoteKey,
          sats: snapshot.sats,
        },
      };
      artifactRef.current = nextArtifact;
      setArtifact(nextArtifact);
      setFailure("");
      setFeedback("주소·금액과 생성한 QR의 원문을 로컬에서 다시 확인했습니다.");
    } catch (error) {
      clearArtifact();
      setFeedback("");
      if (error instanceof P2PReceiveRequestError && error.code === "ADDRESS_UNSAFE") {
        if (inputRef.current) inputRef.current.value = "";
        setAddressInput("");
        setAddressConfirmed(false);
        setAmountConfirmed(false);
      }
      setFailure(error instanceof Error ? error.message : "수취 요청을 만들지 못했습니다.");
    }
  }

  function artifactIsUsable(candidate: Artifact | null): candidate is Artifact {
    return Boolean(
      candidate
      && artifactRef.current === candidate
      && candidate.source.quoteKey === quoteKey
      && candidate.source.address === candidate.request.address
      && candidate.source.sats === Number(candidate.request.sats)
      && Date.now() < candidate.source.expiresAt,
    );
  }

  async function copyUri() {
    const candidate = artifact;
    if (!artifactIsUsable(candidate)) {
      setFailure("거래 조건이나 주소가 바뀌었습니다. 수취 요청을 다시 만드세요.");
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setFailure("이 브라우저에서 클립보드를 사용할 수 없습니다.");
      return;
    }
    const generation = generationRef.current;
    try {
      await navigator.clipboard.writeText(candidate.request.uri);
      if (!mountedRef.current) return;
      if (generationRef.current !== generation || !artifactIsUsable(candidate)) {
        setFeedback("");
        setFailure("요청이 바뀌는 동안 이전 URI가 복사되었을 수 있습니다. 복사한 내용은 사용하지 말고 새 요청을 만드세요.");
        return;
      }
      setFeedback("요청 URI를 복사했습니다. 클립보드 동기화 설정을 확인하세요.");
      setFailure("");
    } catch {
      if (!mountedRef.current) return;
      setFailure("요청 URI를 복사하지 못했습니다.");
    }
  }

  async function downloadQr() {
    const candidate = artifact;
    const canvas = canvasRef.current;
    if (!artifactIsUsable(candidate) || !canvas) {
      setFailure("거래 조건이나 주소가 바뀌었습니다. 수취 요청을 다시 만드세요.");
      return;
    }
    const generation = generationRef.current;
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value) resolve(value);
          else reject(new Error("png"));
        }, "image/png");
      });
      if (!mountedRef.current || generationRef.current !== generation || !artifactIsUsable(candidate)) return;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = "bitcoin-payment-request.png";
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
      setFeedback("QR PNG 다운로드를 시작했습니다. 다운로드 폴더와 클라우드 동기화 설정을 확인하세요.");
      setFailure("");
    } catch {
      if (!mountedRef.current) return;
      setFailure("QR PNG를 만들지 못했습니다.");
    }
  }

  return (
    <section className="receive-request" aria-labelledby="receive-request-title">
      <header>
        <div>
          <p className="section-kicker">거래 다음 단계</p>
          <h2 id="receive-request-title">구매자 수취 주소</h2>
        </div>
        <span>선택 기능 · 로컬 처리</span>
      </header>

      {!isBuyer ? (
        <div className="receive-request-empty">
          <strong>구매자가 자신의 지갑에서 준비합니다.</strong>
          <p>판매자는 구매자가 직접 확인한 새 수취 주소와 정확한 sats를 별도 채널에서 받으세요.</p>
        </div>
      ) : !snapshot ? (
        <div className="receive-request-start">
          <p>계산 결과를 고정한 뒤, 이번 거래에 쓸 새 메인넷 수취 주소와 정확한 금액의 QR을 만들 수 있습니다.</p>
          {sats && paymentKrw ? (
            <dl>
              <div><dt>고정할 수취량</dt><dd>{formatSats(sats)}</dd></div>
              <div><dt>현재 원화 조건</dt><dd>{formatKrw(paymentKrw)}</dd></div>
            </dl>
          ) : null}
          <button type="button" onClick={startRequest} disabled={!canStart}>
            {quoteCurrent ? "현재 거래 조건으로 수취 요청 시작" : "최신 시세 확인 후 시작"}
          </button>
          <p>역할·금액·프리미엄을 바꾸면 다시 확인합니다. 주소는 거래 조건 공유 링크·거래 조건 이미지·서버에는 넣지 않습니다. 직접 복사한 URI와 저장한 QR에는 주소·금액이 포함됩니다.</p>
        </div>
      ) : (
        <>
          <div className="receive-snapshot" role="note">
            <span>10분 고정 조건</span>
            <strong>{formatSats(snapshot.sats)}</strong>
            <span>고정 원화 조건</span>
            <strong>{formatKrw(snapshot.paymentKrw)}</strong>
            <small>판매자는 채굴 수수료를 별도로 부담 · 구매자 수령량에서 차감하지 않음</small>
          </div>

          <label className="receive-address-field" htmlFor="p2p-receive-address">
            <span>내 지갑의 새 수취 주소</span>
            <input
              ref={inputRef}
              id="p2p-receive-address"
              type="text"
              inputMode="text"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={addressInput}
              onChange={(event) => changeAddress(event.target.value)}
              placeholder="bc1… 또는 1… / 3…"
              aria-describedby="p2p-receive-address-note"
            />
          </label>
          <p id="p2p-receive-address-note" className="receive-address-note">
            주소 한 개만 붙여넣으세요. bitcoin: URI·xpub·descriptor·복구문구·개인키는 넣지 마세요.
          </p>

          <div className="receive-confirmations">
            <label>
              <input
                type="checkbox"
                checked={addressConfirmed}
                onChange={(event) => {
                  clearArtifact();
                  setAddressConfirmed(event.target.checked);
                  if (!event.target.checked) setAmountConfirmed(false);
                }}
                disabled={!addressInput}
              />
              <span>나는 BTC를 받을 구매자이며, 내 지갑에서 이번 거래용으로 새로 만든 아직 사용하지 않은 주소의 <b>전체 주소</b>와 위 입력이 정확히 같습니다.</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={amountConfirmed}
                onChange={(event) => {
                  clearArtifact();
                  setAmountConfirmed(event.target.checked);
                }}
                disabled={!addressConfirmed}
              />
              <span>판매자가 <b>{formatSats(snapshot.sats)}</b>를 보내고 채굴 수수료를 별도로 부담합니다.</span>
            </label>
          </div>

          <div className="receive-actions">
            <button
              type="button"
              onClick={buildRequest}
              disabled={!addressInput || !addressConfirmed || !amountConfirmed}
            >
              주소·금액 QR 만들기
            </button>
            <button type="button" className="is-secondary" onClick={() => clearSensitive(false)}>
              모두 지우기
            </button>
          </div>

          {artifact ? (
            <div ref={resultRef} className="receive-artifact">
              <div className="receive-proof">
                <span>로컬 재검증 완료</span>
                <strong>{formatSats(Number(artifact.request.sats))}</strong>
                <dl>
                  <div>
                    <dt>전체 주소</dt>
                    <dd><code dir="ltr">{artifact.request.address}</code></dd>
                  </div>
                  <div>
                    <dt>주소 유형</dt>
                    <dd>{SCRIPT_LABELS[artifact.request.scriptType] ?? artifact.request.scriptType}</dd>
                  </div>
                  <div>
                    <dt>QR 원문</dt>
                    <dd><code dir="ltr">{artifact.request.uri}</code></dd>
                  </div>
                </dl>
              </div>
              <canvas
                ref={canvasRef}
                className="receive-qr"
                role="img"
                aria-label={artifact.request.sats + " sats 비트코인 수취 요청 QR"}
              />
              <p>복사한 URI와 저장한 QR PNG에는 전체 주소·금액이 포함됩니다. 운영체제 클립보드·다운로드 폴더·클라우드 동기화 정책을 먼저 확인하세요.</p>
              <div className="receive-export-actions">
                <button type="button" onClick={() => void copyUri()}>요청 URI 복사</button>
                <button type="button" onClick={() => void downloadQr()}>QR PNG 저장</button>
              </div>
              <p>이 사이트는 주소 소유·새 주소·미사용 여부·결제·확정·페이지 무결성을 증명하지 않습니다. 사용한 주소는 다시 쓰지 말고, 판매자는 지갑의 최종 송금 화면에서 전체 주소와 금액을 다시 확인하세요.</p>
            </div>
          ) : null}
        </>
      )}

      <p className="receive-feedback" aria-live="polite" role={failure ? "alert" : undefined}>
        {failure || feedback}
      </p>
    </section>
  );
}
