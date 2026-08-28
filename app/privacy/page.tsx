/* eslint-disable @next/next/no-html-link-for-pages -- Vinext static export currently breaks next/link navigation. */
import type { Metadata } from "next";
import { SiteRouteNav } from "../components/SiteRouteNav";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "개인정보·데이터 안내 | 비트코인 P2P 계산기",
  description: "비트코인 P2P 계산기가 처리·보관·공유하는 데이터와 브라우저 초안 삭제, 공개 링크 비활성화 방법입니다.",
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
          <p>계산은 브라우저에서 처리됩니다. 거래 기록 카드를 만들 때만 선택한 거래 조건과 수취정보를 서버로 보냅니다. 공개 링크가 있으면 누구나 로그인 없이 최대 180일간 기록을 볼 수 있습니다.</p>
        </header>

        <div className="privacy-content">
          <section aria-labelledby="local-data-title">
            <h2 id="local-data-title">이 브라우저에 저장되는 정보</h2>
            <ul>
              <li>거래 역할, 원화·비트코인 금액, 프리미엄과 표시 단위는 초안 복구를 위해 최대 12시간 저장될 수 있습니다. 자금 출처와 모집글 메모는 저장하지 않으며, 초안을 시세 제공자나 거래 기록 서버로 자동 전송하지 않습니다.</li>
              <li><strong>저장된 초안 삭제</strong>를 누르면 저장된 초안이 삭제되고 현재 탭의 입력이 초기화됩니다. 같은 사이트를 연 다른 탭에는 일반적인 초안 변경과 이 버튼으로 한 삭제가 동기화됩니다.</li>
              <li>준비·공개 기록을 관리하는 데 필요한 기록 ID, 확인 링크와 관리 정보도 저장될 수 있습니다. 비공개 준비 기록은 최대 15분, 공개 기록의 관리 정보는 비활성화하거나 만료될 때까지 최대 180일간 유지됩니다.</li>
              <li>브라우저 사이트 데이터를 삭제하면 이 관리 정보는 사라지지만 서버의 공개 기록은 비활성화되지 않습니다. 이미 열린 탭에는 탭을 닫을 때까지 관리 정보가 메모리에 남을 수 있습니다.</li>
            </ul>
          </section>

          <section aria-labelledby="delete-order-title">
            <h2 id="delete-order-title">나중에 삭제하는 방법</h2>
            <ol>
              <li>공개 기록이 있으면 먼저 거래 기록 관리에서 <strong>공개 링크 비활성화</strong>를 누릅니다.</li>
              <li>계산 초안은 <strong>저장된 초안 삭제</strong>를 누릅니다.</li>
              <li>이 사이트를 연 탭을 모두 닫습니다.</li>
              <li>필요하면 브라우저 설정에서 이 사이트의 데이터를 삭제합니다.</li>
            </ol>
            <p>공개 링크를 비활성화하기 전에 관리 정보를 지우고 관련 탭까지 닫으면 나중에 관리 권한을 복구할 수 없습니다. 이 경우 공개 기록은 정해진 만료 시각까지 유지됩니다.</p>
          </section>

          <section aria-labelledby="public-record-title">
            <h2 id="public-record-title">링크를 아는 사람이 볼 수 있는 거래 기록</h2>
            <ul>
              <li>카드 준비를 시작하면 거래 역할·금액·시세·프리미엄·선택한 자금 출처와 온체인 주소·BIP21·Lightning Address·BOLT11 중 입력한 수취정보가 서버로 전송됩니다.</li>
              <li>서버가 만든 비공개 준비 기록은 최대 15분 후 폐기됩니다. 카드 공유 또는 PNG 저장을 마친 뒤 공개를 확정한 기록만 최대 180일간 보관됩니다.</li>
              <li>관리 정보가 브라우저나 열린 탭에 남아 있으면 공개 링크를 일찍 비활성화할 수 있습니다. 비활성화한 뒤 공개 내용은 더 이상 열리지 않으며, 같은 관리 정보의 재사용을 막기 위한 최소 상태값만 보관 기간 동안 남습니다.</li>
              <li>확인 링크만 가진 사람은 기록을 비활성화할 수 없습니다. 관리 정보는 거래 기록의 생성·공개 확정·비활성화 요청에만 이 사이트의 서버로 보내며 외부 시세·결제정보 제공자에게 보내지 않습니다.</li>
              <li>서명은 기록이 바뀌지 않았다는 점만 확인하며 거래 당사자의 신원, 합의, 입금, BTC 전송 또는 거래 완료를 증명하지 않습니다.</li>
            </ul>
          </section>

          <section aria-labelledby="external-data-title">
            <h2 id="external-data-title">외부 서비스와 운영 로그</h2>
            <ul>
              <li>실시간 시세를 표시할 때 브라우저가 업비트에 직접 연결할 수 있습니다. 시세·프리미엄·권장 수수료율 조회에는 업비트, 업비트 데이터랩과 mempool.space가 사용됩니다.</li>
              <li>Lightning Address 또는 LNURL로 인보이스를 만들면 해당 제공자에게 수취 계정과 요청 금액이 전달됩니다.</li>
              <li>Cloudflare는 사이트 제공, 요청 제한, 장애 분석과 보안을 위해 IP 주소 등 통상적인 요청 정보를 처리할 수 있습니다. 애플리케이션 오류 로그는 요청 본문, 결제정보, 기록 ID와 관리 토큰을 기록하지 않도록 제한합니다.</li>
            </ul>
          </section>

          <section aria-labelledby="contact-title">
            <h2 id="contact-title">문의와 변경</h2>
            <p>데이터 처리에 관한 문의는 제작자의 <a href="https://x.com/thumbking0227" target="_blank" rel="noopener noreferrer">X 계정 @thumbking0227</a> 또는 일반적인 문의에 한해 <a href="https://github.com/thumbking-btc/bitcoin-p2p-check/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a>로 보내십시오. 문의로 공개 링크를 대신 비활성화할 수는 없습니다. 공개 Issue에 거래 내용, 수취정보, 기록 ID 또는 관리 토큰을 게시하지 마십시오. 처리 내용이 달라지면 이 페이지의 시행일과 변경 이력을 함께 갱신합니다.</p>
          </section>
        </div>
      </main>

      <footer className="site-footer site-footer-nav-only">
        <SiteRouteNav current="privacy" />
      </footer>
    </>
  );
}
