/* eslint-disable @next/next/no-html-link-for-pages -- Vinext static export currently breaks next/link navigation. */
import type { Metadata } from "next";
import { TradeRecordVerifier } from "./TradeRecordVerifier";
import styles from "./verify.module.css";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "공유된 거래 정보 | 비트코인 P2P 계산기",
  description: "공유된 비트코인 P2P 거래 조건과 결제정보를 확인하고 복사합니다.",
  alternates: { canonical: "/verify/" },
  robots: { index: false, follow: false },
  openGraph: {
    title: "공유된 거래 정보",
    description: "공유된 거래 조건과 결제정보를 확인하고 필요한 항목을 복사합니다.",
    type: "website",
    url: "/verify/",
    images: [],
  },
  twitter: {
    card: "summary",
    title: "공유된 거래 정보",
    description: "공유된 거래 조건과 결제정보를 확인하고 필요한 항목을 복사합니다.",
    images: [],
  },
};

export default function VerifyPage() {
  return (
    <main className={styles.page}>
      <a className={styles.back} href="/">← 계산기로 돌아가기</a>
      <header className={styles.heading}>
        <p>비트코인 P2P 계산기</p>
        <h1>공유된 거래 정보</h1>
        <span>거래 조건과 결제정보를 확인하고 필요한 항목만 복사할 수 있습니다.</span>
      </header>
      <TradeRecordVerifier />
    </main>
  );
}
