"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function compactShareText(text: string) {
  const marker = "\n[가격 계산]\n";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return text;
  const verificationMarker = "\n\n거래 조건 검증하기:";
  const verificationIndex = text.indexOf(verificationMarker, markerIndex + marker.length);
  const head = text.slice(0, markerIndex).trimEnd();
  if (verificationIndex < 0) return head;
  return `${head}${text.slice(verificationIndex)}`;
}

export function ShareDetailsPreference() {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [includeDetails, setIncludeDetails] = useState(false);
  const fullTextRef = useRef("");

  useEffect(() => {
    document.documentElement.dataset.includePriceDetails = includeDetails ? "true" : "false";

    const sync = () => {
      const details = document.querySelector<HTMLElement>(".trade-share-preview");
      const pre = details?.querySelector<HTMLPreElement>("pre[aria-label='거래 조건 이미지와 함께 공유되는 문구']");
      if (!details || !pre) {
        setMount(null);
        return;
      }

      let host = details.querySelector<HTMLElement>("[data-share-details-preference]");
      if (!host) {
        host = document.createElement("div");
        host.dataset.shareDetailsPreference = "true";
        pre.insertAdjacentElement("afterend", host);
      }
      setMount(host);

      const current = pre.textContent ?? "";
      if (current.includes("\n[가격 계산]\n")) fullTextRef.current = current;
      const desired = includeDetails
        ? fullTextRef.current || current
        : compactShareText(fullTextRef.current || current);
      if (current !== desired) pre.textContent = desired;
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    sync();
    return () => {
      observer.disconnect();
      delete document.documentElement.dataset.includePriceDetails;
    };
  }, [includeDetails]);

  if (!mount) return null;
  return createPortal(
    <label style={{ display: "flex", alignItems: "center", gap: "8px", padding: "12px 0 2px", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={includeDetails}
        onChange={(event) => setIncludeDetails(event.target.checked)}
      />
      <span>상세 계산정보 포함 <small style={{ opacity: 0.68 }}>(선택 사항)</small></span>
    </label>,
    mount,
  );
}
