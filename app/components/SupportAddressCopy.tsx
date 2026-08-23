"use client";

import { useState } from "react";

type SupportAddressCopyProps = {
  address: string;
};

export function SupportAddressCopy({ address }: SupportAddressCopyProps) {
  const [copyStatus, setCopyStatus] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopyFailed(false);
      setCopyStatus("주소를 복사했습니다.");
    } catch {
      setCopyFailed(true);
      setCopyStatus("복사하지 못했습니다. 주소를 길게 눌러 복사해 주세요.");
    }
  }

  return (
    <figcaption className="support-address-card">
      <span>라이트닝 주소</span>
      <code>{address}</code>
      <button type="button" aria-label="라이트닝 주소 복사" onClick={copyAddress}>
        복사
      </button>
      <p
        className={`support-status${copyFailed ? " is-error" : ""}`}
        aria-live="polite"
        role={copyFailed ? "alert" : undefined}
      >
        {copyStatus}
      </p>
    </figcaption>
  );
}
