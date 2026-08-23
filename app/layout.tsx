import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "./components/PwaRegistration";
import "./runtime-globals.css";

export const viewport: Viewport = {
  themeColor: "#f7931a",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://bitcoin-p2p-check.thumbking-btc.workers.dev"),
  title: "비트코인 P2P 계산기",
  description: "업비트 최근 체결가와 판매자 프리미엄으로 P2P 거래 조건을 계산하고 모집글 또는 이미지로 공유합니다.",
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: "/favicon-v2.svg",
    shortcut: "/favicon-v2.svg",
    apple: "/icons/apple-touch-icon-v2.png",
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "P2P 계산기",
  },
  openGraph: {
    title: "비트코인 P2P 계산기",
    description: "원화와 비트코인을 주고받을 조건을 계산하고 거래 모집글 또는 조건 이미지로 공유합니다.",
    type: "website",
    locale: "ko_KR",
    images: [{
      url: "/og-v2.png",
      width: 1200,
      height: 630,
      alt: "비트코인 P2P 계산기 — 원화와 비트코인 거래 조건 계산 및 공유",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "비트코인 P2P 계산기",
    description: "원화와 비트코인을 주고받을 조건을 계산하고 거래 모집글 또는 조건 이미지로 공유합니다.",
    images: ["/og-v2.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}
