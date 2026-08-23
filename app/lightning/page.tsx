/* eslint-disable @next/next/no-html-link-for-pages -- Vinext static export currently breaks next/link navigation. */

import type { Metadata } from "next";

import { LightningAddressRequest } from "../components/LightningAddressRequest";
import styles from "./lightning.module.css";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "라이트닝 결제 요청 프리뷰 | 비트코인 P2P 계산기",
  description: "라이트닝 주소로 정확한 금액의 BOLT11 인보이스와 QR을 만드는 실험 기능입니다.",
};

export default function LightningRequestPage() {
  return (
    <>
      <main className="site-main">
        <section className="trade-tool">
          <article className="capture-card">
            <header className={`tool-heading ${styles.pageHeading}`}>
              <div className="brand-line">
                <span className="brand-mark" aria-hidden="true">₿</span>
                <h1>라이트닝 요청</h1>
              </div>
              <a className={styles.backLink} href="/">계산기로 돌아가기</a>
            </header>
            <p className={styles.intro}>
              라이트닝 주소와 받을 사토시를 입력하면 해당 지갑 서비스가 금액이 고정된 새 BOLT11 인보이스를 발급합니다. 인보이스를 이미 만들었다면 직접 붙여 넣어 금액과 QR을 확인할 수 있습니다.
            </p>
          </article>
          <LightningAddressRequest />
        </section>
      </main>

      <footer className="site-footer">
        <nav className="site-route-nav" aria-label="사이트 메뉴">
          <a href="/">₿ 비트코인 P2P 계산기</a>
          <span aria-current="page">라이트닝 결제 요청 프리뷰</span>
        </nav>
        <p>이 프리뷰는 거래를 중개하거나 결제 완료를 보증하지 않습니다.</p>
      </footer>
    </>
  );
}
