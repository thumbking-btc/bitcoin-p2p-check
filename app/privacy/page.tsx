/* eslint-disable @next/next/no-html-link-for-pages -- Vinext static export currently breaks next/link navigation. */
import type { Metadata } from "next";
import { SiteRouteNav } from "../components/SiteRouteNav";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "개인정보·데이터 안내 | 비트코인 P2P 계산기",
  description: "비트코인 P2P 계산기가 처리·보관·공유하는 데이터와 사용자가 직접 삭제하거나 공개 기록을 철회하는 방법입니다.",
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
          <p className="section-label">시행일 · 2026년 8월 26일</p>
          <h1>개인정보·데이터 안내</h1>
          <p>계산 자체는 브라우저에서 처리됩니다. 거래 기록 카드를 만들 때만 선택한 거래 조건과 수취정보가 서버로 전송되며, 공유 전에 공개 범위와 보관 기간을 확인해야 합니다.</p>
        </header>

        <div className="privacy-content">
          <section aria-labelledby="local-data-title">
            <h2 id="local-data-title">기기에만 저장되는 정보</h2>
            <ul>
              <li>원화·비트코인 금액, 프리미엄, 거래 역할과 표시 단위는 초안 복구를 위해 현재 브라우저의 로컬 저장소에 최대 12시간 보관될 수 있습니다. 자금 출처와 모집글 메모는 자동 저장하지 않습니다.</li>
              <li>이 초안은 시세 제공자나 거래 기록 API로 자동 전송되지 않습니다.</li>
              <li>계산기에서 제공하는 초안 삭제 기능을 사용하거나 브라우저 사이트 데이터를 삭제하면 제거됩니다. 같은 사이트를 연 다른 탭에는 삭제·변경 사실이 동기화됩니다.</li>
              <li>준비·공유 실패 뒤 서버의 자동 철회가 실패하면 재시도를 위해 준비 기록의 ID·확인 링크·철회 권한 토큰을 현재 브라우저의 사이트 저장소에 최대 15분간 개별 보관할 수 있습니다.</li>
              <li>카드 전달 뒤 공개 확정 요청 전에는 응답 유실에 대비해 같은 관리 정보를 먼저 저장합니다. 재접속 시 브라우저 저장이 확인된 항목은 같은 출처 서버에 공개 확정을 멱등적으로 재시도하고, 저장 실패·사이트 데이터 삭제 뒤 메모리에만 남은 항목은 공개 상태만 확인합니다. 공개 기록이면 기록 만료 시까지 유지하고, 서버에서 공개 확정할 수 없는 것으로 확인된 준비 기록은 삭제합니다. 사전 저장에 실패하면 공개 확정을 시작하지 않습니다.</li>
              <li>브라우저 사이트 데이터를 삭제하면 다음 접속에서 철회 권한을 복구할 수 없습니다. 다만 이미 열린 계산기 탭은 안전한 철회 또는 탭 종료를 위해 메모리 사본을 유지할 수 있으므로 완전히 없애려면 해당 사이트의 탭을 모두 닫아야 합니다. 공유 기기를 사용하는 다른 사람은 저장되었거나 열린 탭에 남은 기록을 철회할 수 있습니다. 만료·철회 시 삭제를 시도하지만 브라우저 설정이나 장애로 실패할 수 있으므로, 삭제 경고가 표시되면 해당 사이트의 탭을 모두 닫은 뒤 브라우저 사이트 데이터를 직접 삭제해야 합니다.</li>
            </ul>
          </section>

          <section aria-labelledby="public-record-title">
            <h2 id="public-record-title">링크를 아는 사람이 볼 수 있는 거래 기록</h2>
            <ul>
              <li>사용자가 거래 기록 카드 준비를 시작하면 거래 조건, 생성 시각, 선택한 온체인 주소·BIP21·Lightning Address·BOLT11 중 해당 정보가 서버로 전송됩니다.</li>
              <li>서버는 금액과 결제정보를 다시 확인한 뒤 15분 후 자동 폐기되는 비공개 준비 기록을 만듭니다. 공유 또는 PNG 저장 동작을 마친 뒤 사용자가 공개 확정을 진행한 기록만 최대 180일간 보관합니다. 원본 확인 링크를 아는 사람은 만료 또는 철회 전까지 내용을 볼 수 있으므로 공개 링크처럼 취급해야 합니다.</li>
              <li>생성한 브라우저에 철회 권한이 남아 있는 동안에는 공유 화면의 철회 기능으로 기록을 조기 삭제할 수 있습니다. 확인 링크만 가진 사람에게는 철회 권한이 없습니다. 철회 권한 토큰은 기록 생성·공개 확정·철회 관리 요청에만 같은 출처 서버로 보내며, 시세·결제정보 제공자 등 외부 서비스에는 보내지 않습니다.</li>
              <li>서명은 기록이 바뀌지 않았다는 점만 확인하며 거래 당사자의 신원, 합의, 입금, BTC 전송 또는 거래 완료를 증명하지 않습니다.</li>
            </ul>
          </section>

          <section aria-labelledby="external-data-title">
            <h2 id="external-data-title">외부 서비스와 운영 로그</h2>
            <ul>
              <li>공개 시세·프리미엄·권장 수수료율 조회에는 업비트, 업비트 데이터랩과 mempool.space가 사용됩니다.</li>
              <li>Lightning Address로 인보이스를 요청하면 해당 주소 제공자에게 거래 금액이 전달됩니다.</li>
              <li>Cloudflare는 사이트 제공, 요청 제한, 장애 분석과 보안을 위해 IP 주소 등 통상적인 요청 메타데이터를 처리할 수 있습니다. 애플리케이션 로그에는 요청 본문, 결제정보, 기록 ID와 철회 토큰을 남기지 않도록 구성합니다.</li>
            </ul>
          </section>

          <section aria-labelledby="contact-title">
            <h2 id="contact-title">문의와 변경</h2>
            <p>데이터 처리나 공개 기록 철회에 관한 문의는 제작자의 <a href="https://x.com/thumbking0227" target="_blank" rel="noopener noreferrer">X 계정 @thumbking0227</a> 또는 일반적인 문의에 한해 <a href="https://github.com/thumbking-btc/bitcoin-p2p-check/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a>로 보내십시오. 공개 Issue에 거래 내용, 수취정보, 기록 ID 또는 철회 토큰을 게시하지 마십시오. 처리 내용이 달라지면 이 페이지의 시행일과 변경 이력을 함께 갱신합니다.</p>
          </section>
        </div>
      </main>

      <footer className="site-footer site-footer-nav-only">
        <SiteRouteNav current="privacy" />
      </footer>
    </>
  );
}
