"use client";

import Image from "next/image";
import { useState } from "react";

const LIGHTNING_ADDRESS = "thumbking@oksu.su";

export function SupportPanel() {
  const [copyStatus, setCopyStatus] = useState("");

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(LIGHTNING_ADDRESS);
      setCopyStatus("주소를 복사했습니다.");
    } catch {
      setCopyStatus("복사하지 못했습니다. 주소를 길게 눌러 복사해 주세요.");
    }
  }

  return (
    <section className="creator-support" aria-label="제작자와 후원">
      <article className="creator-card" aria-labelledby="creator-title">
        <Image
          className="creator-logo"
          src="/creator-logo.jpg"
          width={1000}
          height={1000}
          alt="엄지왕 로고"
          unoptimized
        />
        <div className="creator-profile">
          <h2 id="creator-title" className="section-label">제작·편찬</h2>
          <p className="creator-name">엄지왕</p>
          <nav aria-label="제작자 소셜 링크">
            <a href="https://x.com/thumbking0227" target="_blank" rel="me noopener noreferrer">
              X · @thumbking0227
            </a>
            <a href="https://www.threads.com/@thumb.ggul" target="_blank" rel="me noopener noreferrer">
              Threads · @thumb.ggul
            </a>
          </nav>
        </div>
      </article>

      <article className="support-card" aria-labelledby="support-title">
        <div className="support-copy">
          <p className="section-label">후원</p>
          <h2 id="support-title">라이트닝으로 후원하기</h2>
          <p>이 계산기가 도움이 되었다면 지속적인 검증과 다음 버전 제작을 후원해 주세요.</p>
          <p className="support-note">
            후원하기 전, 라이트닝 지갑에 표시된 수신 주소가 아래 주소와 같은지 확인해 주세요.
          </p>
        </div>

        <figure className="support-figure">
          <svg
            className="support-qr"
            viewBox="0 0 445 445"
            role="img"
            aria-labelledby="support-qr-title support-qr-desc"
          >
            <title id="support-qr-title">엄지왕 라이트닝 후원 QR</title>
            <desc id="support-qr-desc">엄지왕 라이트닝 후원 주소를 담은 QR 코드</desc>
            <image
              href="/lightning-support-qr.png"
              width="445"
              height="445"
              preserveAspectRatio="none"
            />
          </svg>
          <figcaption className="support-address-card">
            <span>라이트닝 주소</span>
            <code>{LIGHTNING_ADDRESS}</code>
            <button type="button" aria-label="라이트닝 주소 복사" onClick={copyAddress}>
              복사
            </button>
          </figcaption>
          <p className="support-status" aria-live="polite">{copyStatus}</p>
        </figure>
      </article>
    </section>
  );
}
