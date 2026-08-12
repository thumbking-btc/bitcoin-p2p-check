/* eslint-disable @next/next/no-html-link-for-pages -- Vinext static export currently breaks next/link navigation. */

type SiteRouteNavProps = {
  current: "calculator" | "install";
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
    </nav>
  );
}
