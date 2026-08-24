import { P2PTradeTool } from "./components/P2PTradeTool";
import { TradeReceiveInfoPortal } from "./components/TradeReceiveInfoPortal";
import { ShareDetailsPreference } from "./components/ShareDetailsPreference";
import { SupportPanel } from "./components/SupportPanel";
import { InstallCta } from "./components/InstallCta";
import { SiteRouteNav } from "./components/SiteRouteNav";

export const dynamic = "force-static";

export default function Home() {
  return (
    <>
      <main className="site-main" style={{ paddingBottom: 24 }}>
        <P2PTradeTool />
        <TradeReceiveInfoPortal />
        <ShareDetailsPreference />

        <details className="reference-details">
          <summary>
            <span>계산 기준·데이터 출처</span>
            <small>프리미엄, 계산식과 공식 출처</small>
          </summary>
          <div className="reference-body">
            <dl className="reference-list">
              <div>
                <dt><span>시장 참고값</span><strong>업비트 프리미엄</strong></dt>
                <dd>업비트 가격과 CoinMarketCap 기준 글로벌 가격의 차이입니다. P2P 계산은 위에 표시된 업비트 가격을 기준으로 합니다.</dd>
              </div>
              <div>
                <dt><span>거래 합의값</span><strong>판매자 프리미엄</strong></dt>
                <dd>비트코인 판매자가 기준 시세보다 높거나 낮게 정한 BTC 단가입니다. 2%라면 기준 시세의 102%로 계산합니다.</dd>
              </div>
              <div>
                <dt><span>네트워크 참고값</span><strong>온체인 수수료율</strong></dt>
                <dd>mempool.space의 권장 수수료율을 표시합니다. sat/vB는 거래 크기 1 vB당 요율이며, 실제 총 수수료는 판매자의 지갑이 구성한 거래 크기에 따라 달라집니다.</dd>
              </div>
              <div>
                <dt><span>구매 계산식</span><strong>받을 sats</strong></dt>
                <dd><code>보낼 원화 ÷ 판매자 BTC 단가 × 100,000,000</code>을 계산한 뒤 1 sat 단위로 반올림합니다.</dd>
              </div>
            </dl>

            <section className="reference-source" aria-labelledby="source-title">
              <div>
                <p className="section-label">데이터와 한계</p>
                <h2 id="source-title">공식 출처와 계산 한계</h2>
              </div>
              <p>업비트 최근 체결가, 업비트 데이터랩 프리미엄과 mempool.space 권장 수수료율을 사용합니다. 이 사이트는 계산만 제공하며 원화·비트코인을 보관하거나 거래를 중개하지 않습니다.</p>
              <div className="reference-links">
                <a href="https://global-docs.upbit.com/docs/upbit-quotation-restful-api" target="_blank" rel="noreferrer">업비트 시세 API 문서 ↗</a>
                <a href="https://datalab.upbit.com/assets/BTC/upbit-premium" target="_blank" rel="noreferrer">업비트 프리미엄 기준 ↗</a>
                <a href="https://mempool.space/docs/api/rest" target="_blank" rel="noreferrer">mempool.space 수수료 API ↗</a>
              </div>
            </section>
          </div>
        </details>

        <details className="reference-details">
          <summary>
            <span>제작자 보기</span>
            <small>제작자 정보와 후원</small>
          </summary>
          <div className="reference-body">
            <SupportPanel />
          </div>
        </details>
      </main>

      <InstallCta showEntry={false} />
      <footer className="site-footer">
        <SiteRouteNav current="calculator" />
        <p>입금 확인과 온체인 전송 확인은 거래 당사자가 직접 해야 합니다.</p>
      </footer>
    </>
  );
}
