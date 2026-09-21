/* eslint-disable @next/next/no-html-link-for-pages -- Vinext static export currently breaks next/link navigation. */

import { APP_VERSION } from "../lib/app-version";

type SiteRouteNavProps = {
  current: "calculator" | "install" | "privacy";
};

export function SiteRouteNav({ current }: SiteRouteNavProps) {
  return (
    <nav className="site-route-nav" aria-label="사이트 메뉴">
      {current === "calculator" ? (
        <span aria-current="page">₿ 비트코인 P2P 계산기</span>
      ) : (
        <a href="/">₿ 비트코인 P2P 계산기</a>
      )}
      {current === "install" ? (
        <span aria-current="page">홈 화면에 추가하는 방법</span>
      ) : (
        <a className="site-route-install" href="/install/">홈 화면에 추가하는 방법</a>
      )}
      {current === "privacy" ? (
        <span aria-current="page">개인정보·데이터 안내</span>
      ) : (
        <a href="/privacy/">개인정보·데이터 안내</a>
      )}
      <span className="app-version" aria-label={`버전 ${APP_VERSION}`}>{`v${APP_VERSION}`}</span>
    </nav>
  );
}
