"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MAX_BOLT11_LENGTH, validateBolt11Invoice } from "../lib/bolt11-invoice.mjs";
import { createOnchainRequest } from "../lib/onchain-request.mjs";
import { createVerifiedTextQr } from "../lib/verified-qr.mjs";
import styles from "./trade-receive-info.module.css";

type Rail = "onchain" | "lightning";
type LightningMode = "address" | "invoice";
type QrArtifact = { data: Uint8ClampedArray; height: number; width: number; payload: string };
type Result = {
  kind: "onchain" | "lightning-address" | "lightning-invoice";
  payload: string;
  shareText: string;
  qr: QrArtifact;
  expiresAt?: number;
};

function findExpectedSats(): number | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".trade-result .transfer-row"));
  const row = rows.find((item) => item.textContent?.includes("판매자 → 구매자"));
  const text = row?.querySelector("dd")?.textContent ?? "";
  const match = text.match(/([\d,]+)\s*sats/i);
  if (!match) return null;
  const sats = Number(match[1].replace(/,/g, ""));
  return Number.isSafeInteger(sats) && sats > 0 ? sats : null;
}

function lightningAddress(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 320 || /\s/.test(normalized)) return null;
  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@") || at === normalized.length - 1) return null;
  const user = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!/^[a-z0-9._+-]{1,128}$/.test(user)) return null;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) return null;
  return `${user}@${domain}`;
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

async function qrFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("QR 생성 실패")), "image/png");
  });
  return new File([blob], name, { type: "image/png", lastModified: Date.now() });
}

function ReceiveInfoPanel({ expectedSats }: { expectedSats: number | null }) {
  const [rail, setRail] = useState<Rail>("onchain");
  const [lightningMode, setLightningMode] = useState<LightningMode>("address");
  const [onchain, setOnchain] = useState("");
  const [address, setAddress] = useState("");
  const [invoice, setInvoice] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const remaining = useMemo(() => {
    if (!result?.expiresAt) return null;
    return Math.max(0, result.expiresAt - Math.floor(Date.now() / 1000));
  }, [result]);

  useLayoutEffect(() => {
    if (!result || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = result.qr.width;
    canvas.height = result.qr.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(result.qr.width, result.qr.height);
    image.data.set(result.qr.data);
    context.imageSmoothingEnabled = false;
    context.putImageData(image, 0, 0);
    image.data.fill(0);
  }, [result]);

  function clear() {
    result?.qr.data.fill(0);
    setResult(null);
    setError("");
    setFeedback("");
  }

  function build() {
    clear();
    if (!expectedSats) {
      setError("거래 금액을 먼저 계산하십시오.");
      return;
    }
    try {
      if (rail === "onchain") {
        const request = createOnchainRequest(onchain.trim(), BigInt(expectedSats));
        const qr = createVerifiedTextQr(request.uri, { maximumLength: 220, maximumPixelSize: 520, level: "M" });
        setResult({
          kind: "onchain",
          payload: request.uri,
          qr,
          shareText: [
            "[BTC 수취정보 · 온체인]",
            `받을 금액: ${formatSats(expectedSats)}`,
            `주소: ${request.address}`,
            `BIP21: ${request.uri}`,
          ].join("\n"),
        });
        setFeedback("주소와 거래 금액을 확인하여 BIP21 QR을 만들었습니다.");
        return;
      }

      if (lightningMode === "address") {
        const normalized = lightningAddress(address);
        if (!normalized) throw new Error("라이트닝 주소는 사용자명@도메인 형식으로 입력하십시오.");
        const qr = createVerifiedTextQr(normalized, { maximumLength: 320, maximumPixelSize: 520, level: "M" });
        setResult({
          kind: "lightning-address",
          payload: normalized,
          qr,
          shareText: [
            "[BTC 수취정보 · 라이트닝 주소]",
            `받을 금액: ${formatSats(expectedSats)}`,
            `라이트닝 주소: ${normalized}`,
            "금액은 주소 QR에 고정되지 않습니다. 위 거래 금액을 확인한 뒤 송금하십시오.",
          ].join("\n"),
        });
        setFeedback("라이트닝 주소와 주소 QR을 만들었습니다.");
        return;
      }

      const checked = validateBolt11Invoice(invoice, {
        expectedSats: BigInt(expectedSats),
        minimumRemainingSeconds: 60,
      });
      const qr = createVerifiedTextQr(checked.canonicalInvoice.toUpperCase(), {
        maximumLength: MAX_BOLT11_LENGTH,
        maximumPixelSize: 520,
        level: "M",
      });
      setResult({
        kind: "lightning-invoice",
        payload: checked.canonicalInvoice,
        expiresAt: checked.expiresAt,
        qr,
        shareText: [
          "[BTC 수취정보 · 라이트닝 인보이스]",
          `받을 금액: ${formatSats(expectedSats)}`,
          `인보이스 만료: ${formatExpiry(checked.expiresAt)}`,
          "BOLT11:",
          checked.canonicalInvoice,
        ].join("\n"),
      });
      setFeedback("인보이스의 메인넷·금액·서명·만료시간을 확인했습니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "수취정보를 확인하지 못했습니다.");
    }
  }

  async function share() {
    if (!result || !canvasRef.current) return;
    if (result.expiresAt && result.expiresAt <= Math.floor(Date.now() / 1000)) {
      setError("인보이스가 만료되었습니다. 지갑에서 새 인보이스를 만든 뒤 다시 입력하십시오.");
      return;
    }
    try {
      const file = await qrFile(canvasRef.current, result.kind === "onchain" ? "onchain-qr.png" : "lightning-qr.png");
      if (navigator.share) {
        const canFile = typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
        if (canFile) {
          await navigator.share({ title: "BTC 수취정보", text: result.shareText, files: [file] });
          setFeedback("수취정보 문구와 QR 이미지를 공유했습니다.");
          return;
        }
        await navigator.share({ title: "BTC 수취정보", text: result.shareText });
        setFeedback("수취정보 문구를 공유했습니다. QR 파일 동시 공유를 지원하지 않는 기기입니다.");
        return;
      }
      await navigator.clipboard.writeText(result.shareText);
      setFeedback("수취정보 문구를 복사했습니다.");
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError("수취정보를 공유하지 못했습니다.");
    }
  }

  return (
    <section className={styles.section} aria-labelledby="receive-info-title">
      <header className={styles.header}>
        <h3 id="receive-info-title">BTC 받을 정보</h3>
        <span className={styles.optional}>선택 사항</span>
      </header>

      <p className={styles.intro}>거래 조건과 함께 받을 주소나 인보이스를 공유할 수 있습니다. 입력하지 않아도 거래 조건만 공유할 수 있습니다.</p>
      <p className={styles.amountNote}><span>구매자만 입력합니다.</span><span>현재 받을 금액</span><b>{expectedSats ? formatSats(expectedSats) : "계산 전"}</b></p>

      <fieldset className={styles.railPicker}>
        <legend>BTC 전송 방식</legend>
        <label>
          <input type="radio" name="embedded-receive-rail" checked={rail === "onchain"} onChange={() => { clear(); setRail("onchain"); }} />
          <span><strong>온체인</strong><small>비트코인 주소</small></span>
        </label>
        <label>
          <input type="radio" name="embedded-receive-rail" checked={rail === "lightning"} onChange={() => { clear(); setRail("lightning"); setLightningMode("address"); }} />
          <span><strong>라이트닝</strong><small>주소 또는 인보이스</small></span>
        </label>
      </fieldset>

      {rail === "onchain" ? (
        <label className={styles.field}>
          <span>온체인 수취 주소</span>
          <input className={styles.input} value={onchain} onChange={(event) => { clear(); setOnchain(event.target.value); }} placeholder="bc1q... 또는 bc1p..." />
        </label>
      ) : (
        <>
          <div className={styles.modeRow}>
            <p>{lightningMode === "address" ? "라이트닝 주소를 그대로 공유합니다." : "지갑에서 만든 인보이스의 금액과 만료를 확인합니다."}</p>
            <button className={styles.modeButton} type="button" onClick={() => { clear(); setLightningMode(lightningMode === "address" ? "invoice" : "address"); }}>
              {lightningMode === "address" ? "인보이스 직접 입력" : "라이트닝 주소 사용"}
            </button>
          </div>
          {lightningMode === "address" ? (
            <label className={styles.field}>
              <span>라이트닝 주소</span>
              <input className={styles.input} value={address} onChange={(event) => { clear(); setAddress(event.target.value); }} placeholder="username@example.com" />
              <small>주소와 주소 QR을 공유합니다. 금액은 QR에 고정되지 않습니다.</small>
            </label>
          ) : (
            <label className={styles.field}>
              <span>BOLT11 인보이스</span>
              <textarea className={styles.textarea} value={invoice} onChange={(event) => { clear(); setInvoice(event.target.value); }} placeholder="lnbc..." />
              <small>현재 거래에서 받을 sats와 정확히 같은 인보이스만 사용할 수 있습니다.</small>
            </label>
          )}
        </>
      )}

      <div className={styles.actions}>
        <button className={styles.primary} type="button" onClick={build}>QR 만들기</button>
        <button className={styles.secondary} type="button" onClick={() => { clear(); setOnchain(""); setAddress(""); setInvoice(""); }}>초기화</button>
      </div>

      {error ? <p className={`${styles.status} ${styles.error}`} role="alert">{error}</p> : feedback ? <p className={styles.status} role="status">{feedback}</p> : null}

      {result ? (
        <div className={styles.result}>
          <div className={styles.resultInfo}>
            <span className={styles.resultBadge}>{result.kind === "onchain" ? "온체인" : result.kind === "lightning-address" ? "라이트닝 주소" : "라이트닝 인보이스"}</span>
            <strong className={styles.resultAmount}>{expectedSats ? formatSats(expectedSats) : "—"}</strong>
            <dl>
              <div><dt>공유 내용</dt><dd>{result.kind === "lightning-invoice" ? "BOLT11 + QR" : result.kind === "lightning-address" ? "주소 + QR" : "BIP21 + QR"}</dd></div>
              {result.expiresAt ? <div><dt>만료</dt><dd>{formatExpiry(result.expiresAt)}{remaining === 0 ? " · 만료됨" : ""}</dd></div> : null}
            </dl>
            <button className={styles.primary} type="button" onClick={() => void share()}>수취정보 공유</button>
          </div>
          <canvas ref={canvasRef} className={styles.qr} aria-label="BTC 수취정보 QR" />
        </div>
      ) : null}
    </section>
  );
}

export function TradeReceiveInfoPortal() {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [expectedSats, setExpectedSats] = useState<number | null>(null);

  useEffect(() => {
    const host = document.createElement("div");
    host.dataset.receiveInfoPortal = "true";

    const sync = () => {
      const tradeImage = document.querySelector<HTMLInputElement>("#output-mode-trade-image")?.checked === true;
      const buyer = document.querySelector<HTMLInputElement>("#trade-role-buyer")?.checked === true;
      const preview = document.querySelector<HTMLElement>(".output-panel:not([hidden]) .trade-share-preview");
      const parent = preview?.parentElement ?? null;
      const shouldShow = Boolean(tradeImage && buyer && preview && parent);

      if (shouldShow && parent && preview) {
        if (host.parentElement !== parent) parent.insertBefore(host, preview);
        setMount(host);
        setVisible(true);
        setExpectedSats(findExpectedSats());
      } else {
        host.remove();
        setVisible(false);
        setMount(null);
      }
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ["checked", "hidden", "value"] });
    document.addEventListener("change", sync, true);
    document.addEventListener("input", sync, true);
    sync();

    return () => {
      observer.disconnect();
      document.removeEventListener("change", sync, true);
      document.removeEventListener("input", sync, true);
      host.remove();
    };
  }, []);

  if (!visible || !mount) return null;
  return createPortal(<ReceiveInfoPanel expectedSats={expectedSats} />, mount);
}
