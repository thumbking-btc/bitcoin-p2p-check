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
            후원하기 전, 라이트닝 지갑에 표시된 수신 주소가 아래 주소와 같은지 확인해 주세요.
          </p>
        </div>

        <figure className="support-figure">
          <Image
            className="support-qr"
            src="/lightning-support-qr.png"
            width={445}
            height={445}
            loading="lazy"
            alt="엄지왕 라이트닝 후원 QR"
            unoptimized
          />
          <figcaption className="visually-hidden">엄지왕 라이트닝 후원 주소를 담은 QR 코드</figcaption>
          <SupportAddressCopy address={LIGHTNING_ADDRESS} />
        </figure>
      </article>
    </section>
  );
}
