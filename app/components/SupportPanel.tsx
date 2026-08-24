import Image from "next/image";
import { SupportAddressCopy } from "./SupportAddressCopy";

const LIGHTNING_ADDRESS = "thumbking@oksu.su";

export function SupportPanel() {
  return (
    <section className="creator-support creator-support-compact" aria-label="제작자와 후원">
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
            후원 전 지갑의 수신 주소가 아래 주소와 같은지 확인해 주세요.
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
          <SupportAddressCopy address={LIGHTNING_ADDRESS} />
        </figure>
      </article>

      <style>{`
        .creator-support-compact {
          gap: 0;
          margin-top: 0;
        }
        .creator-support-compact .creator-card,
        .creator-support-compact .support-card {
          border: 0;
          border-radius: 0;
          background: transparent;
          box-shadow: none;
        }
        .creator-support-compact .creator-card {
          grid-template-columns: 112px minmax(0, 1fr);
          gap: 20px;
          padding: 20px 18px;
          border-bottom: 1px solid var(--line);
        }
        .creator-support-compact .creator-logo {
          width: 112px;
          height: 112px;
        }
        .creator-support-compact .creator-profile {
          gap: 6px;
        }
        .creator-support-compact .creator-name {
          font-size: clamp(26px, 4.5vw, 36px);
        }
        .creator-support-compact .creator-profile nav {
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          margin-top: 2px;
        }
        .creator-support-compact .creator-profile a {
          min-height: 42px;
          padding: 8px 10px;
          border-radius: 0;
          font-size: 12px;
        }
        .creator-support-compact .support-card {
          grid-template-columns: minmax(0, 1fr) 190px;
          gap: 22px;
          padding: 20px 18px;
        }
        .creator-support-compact .support-copy {
          gap: 6px;
        }
        .creator-support-compact .support-copy h2 {
          font-size: clamp(22px, 4vw, 30px);
        }
        .creator-support-compact .support-copy > p {
          font-size: 12px;
          line-height: 1.55;
        }
        .creator-support-compact .support-copy .support-note {
          margin-top: 4px;
          padding-top: 8px;
        }
        .creator-support-compact .support-figure {
          width: 190px;
        }
        @media (max-width: 640px) {
          .creator-support-compact .creator-card {
            grid-template-columns: 88px minmax(0, 1fr);
            justify-items: stretch;
            gap: 14px;
            padding: 16px 18px;
          }
          .creator-support-compact .creator-logo {
            width: 88px;
            height: 88px;
          }
          .creator-support-compact .creator-profile {
            width: auto;
            text-align: left;
          }
          .creator-support-compact .creator-profile nav {
            grid-template-columns: 1fr;
            gap: 6px;
            text-align: left;
          }
          .creator-support-compact .creator-profile a {
            min-height: 40px;
          }
          .creator-support-compact .support-card {
            grid-template-columns: 1fr;
            gap: 14px;
            padding: 16px 18px 18px;
          }
          .creator-support-compact .support-figure {
            width: min(210px, 68vw);
          }
        }
      `}</style>
    </section>
  );
}
