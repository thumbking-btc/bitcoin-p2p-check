/* eslint-disable @next/next/no-html-link-for-pages -- Vinext static export currently breaks next/link navigation. */
import type { Metadata } from "next";
import { SiteRouteNav } from "../components/SiteRouteNav";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "개인정보·데이터 안내 | 비트코인 P2P 계산기",
  description: "비트코인 P2P 계산기에 저장되는 정보와 삭제 방법을 안내합니다.",
  alternates: {
    canonical: "/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <>
      <main className="privacy-page">
        <a className="install-back" href="/">← 계산기로 돌아가기</a>
        <header>
          <p className="section-label">시행일 · 2026년 8월 29일</p>
          <h1>개인정보·데이터 안내</h1>
          <p>계산 내용은 이 브라우저에서 처리합니다. 거래 기록 카드를 만들 때만 필요한 내용을 서버에 저장합니다.</p>
        </header>

        <div className="privacy-content">
          <section aria-labelledby="local-data-title">
            <h2 id="local-data-title">이 브라우저에 저장되는 정보</h2>
            <ul>
              <li>금액·프리미엄 등 계산 초안은 최대 12시간 저장됩니다. 자금 출처와 모집글 메모는 초안에 저장하지 않습니다.</li>
              <li><strong>저장된 초안 삭제</strong>를 누르면 초안이 삭제되고 현재 화면의 입력이 초기화됩니다.</li>
              <li>공개 링크를 관리하는 정보도 저장됩니다. 브라우저 사이트 데이터를 지워도 서버의 공개 링크는 그대로 남습니다.</li>
            </ul>
          </section>

          <section aria-labelledby="delete-order-title">
            <h2 id="delete-order-title">나중에 삭제하는 방법</h2>
            <ol>
              <li>공개 기록이 있으면 먼저 <strong>공개 링크 비활성화</strong>를 누릅니다.</li>
              <li><strong>저장된 초안 삭제</strong>를 누릅니다.</li>
              <li>이 사이트를 연 탭을 모두 닫고, 필요하면 브라우저의 사이트 데이터를 삭제합니다.</li>
            </ol>
            <p>사이트 데이터를 먼저 지우면 공개 링크를 나중에 비활성화할 수 없습니다. 이 경우 링크는 만료될 때까지 남습니다.</p>
          </section>

          <section aria-labelledby="public-record-title">
            <h2 id="public-record-title">공개 링크에 저장되는 정보</h2>
            <ul>
              <li>거래 역할·금액·시세·프리미엄·선택한 자금 출처와 입력한 수취정보가 저장됩니다.</li>
              <li>공개 링크가 있으면 누구나 로그인 없이 최대 180일간 기록을 볼 수 있습니다.</li>
              <li>공개 전 준비 기록은 최대 15분 후 자동으로 삭제됩니다.</li>
              <li>링크를 비활성화하면 공개 내용은 삭제됩니다. 보안을 위해 비활성화되었다는 표시만 최대 180일간 남습니다.</li>
              <li>서명은 기록이 바뀌지 않았다는 점만 확인하며 거래 당사자의 신원, 합의, 입금, BTC 전송 또는 거래 완료를 증명하지 않습니다.</li>
            </ul>
          </section>

          <section aria-labelledby="external-data-title">
            <h2 id="external-data-title">외부 서비스와 운영 로그</h2>
            <ul>
              <li>시세와 수수료 조회에는 업비트, 업비트 데이터랩과 mempool.space를 사용합니다.</li>
              <li>Lightning 인보이스를 만들면 해당 제공자에게 수취 계정과 금액을 보냅니다.</li>
              <li>Cloudflare는 사이트 운영과 보안을 위해 IP 주소 등 기본 접속 정보를 처리할 수 있습니다. 오류 로그에는 거래 내용과 관리 정보를 남기지 않습니다.</li>
            </ul>
          </section>

          <section aria-labelledby="contact-title">
            <h2 id="contact-title">문의</h2>
            <p><a href="https://x.com/thumbking0227" target="_blank" rel="noopener noreferrer">X 계정 @thumbking0227</a> 또는 <a href="https://github.com/thumbking-btc/bitcoin-p2p-check/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a>로 문의하십시오. 공개 글에는 거래 내용, 수취정보나 관리 정보를 올리지 마십시오.</p>
          </section>
        </div>
      </main>

      <footer className="site-footer site-footer-nav-only">
        <SiteRouteNav current="privacy" />
      </footer>
    </>
  );
}
