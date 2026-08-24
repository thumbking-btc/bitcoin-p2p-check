/* eslint-disable @next/next/no-html-link-for-pages -- Vinext static export currently breaks next/link navigation. */
import type { Metadata } from "next";
import { TradeRecordVerifier } from "./TradeRecordVerifier";
import styles from "./verify.module.css";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "거래 조건 원본 확인 | 비트코인 P2P 계산기",
  description: "서명된 비트코인 P2P 거래 조건이 생성 이후 변경되지 않았는지 확인합니다.",
  alternates: { canonical: "/verify/" },
  robots: { index: false, follow: false },
  openGraph: {
    title: "거래 조건 원본 확인",
    description: "이 사이트의 키로 서명된 거래 조건이 변경되지 않았는지 확인합니다.",
    type: "website",
    url: "/verify/",
    images: [],
  },
  twitter: {
    card: "summary",
    title: "거래 조건 원본 확인",
    description: "서명된 거래 조건의 원본 유지 여부를 확인합니다.",
    images: [],
  },
};

export default function VerifyPage() {
  return (
    <main className={styles.page}>
      <a className={styles.back} href="/">← 계산기로 돌아가기</a>
      <header className={styles.heading}>
        <p>비트코인 P2P 계산기 · 서명 검증</p>
        <h1>거래 조건 원본 확인</h1>
        <span>짧은 식별자로 서버의 기록을 가져온 뒤, 이 기기에 내장된 공개키로 서명을 확인합니다.</span>
      </header>
      <TradeRecordVerifier />
    </main>
  );
}
