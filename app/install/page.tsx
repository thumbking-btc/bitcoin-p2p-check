/* eslint-disable @next/next/no-html-link-for-pages -- Vinext static export currently breaks next/link navigation. */
import type { Metadata } from "next";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "홈 화면에 추가하기 | 비트코인 P2P 계산기",
  description: "iPhone Safari, Android Chrome, PC에서 비트코인 P2P 계산기를 설치하는 방법입니다.",
  alternates: {
    canonical: "/install",
  },
  openGraph: {
    title: "비트코인 P2P 계산기 홈 화면에 추가하기",
    description: "기기에 맞는 설치 단계를 확인하거나 안내 이미지를 저장해 전달하세요.",
    url: "/install",
    images: [
      {
        url: "/install/iphone-guide-v1.png",
        width: 1080,
        height: 1920,
        alt: "iPhone에서 비트코인 P2P 계산기를 홈 화면에 추가하는 안내",
      },
    ],
  },
};

const iphoneSteps = [
  "Discord·X 같은 앱 안에서 열었다면 Safari로 연 뒤, 아래쪽의 더 보기(…)를 누릅니다.",
  "빠른 메뉴에서 공유를 누릅니다. 공유 아이콘이 바로 보이면 그것을 눌러도 됩니다.",
  "공유 창에서 더 보기를 누릅니다. ‘간략히 보기’라고 표시된다면 이미 펼쳐진 상태입니다.",
  "펼친 목록에서 홈 화면에 추가를 누릅니다.",
  "웹 앱으로 열기를 확인하고 오른쪽 위 추가를 누릅니다.",
];

const androidSteps = [
  "앱 안 브라우저에서 열었다면 Chrome으로 연 뒤, 오른쪽 위의 ⋮ 메뉴를 누릅니다.",
  "앱 설치, 설치 및 바로가기 만들기 또는 홈 화면에 추가를 선택합니다.",
  "확인 창에서 설치를 누릅니다.",
];

export default function InstallPage() {
  return (
    <main className="install-page">
      <a className="install-back" href="/">← 계산기로 돌아가기</a>

      <header className="install-heading">
        <p className="section-label">비트코인 P2P 계산기 · PWA</p>
        <h1>홈 화면에 추가하기</h1>
        <p className="install-heading-copy">기기에 맞는 방법으로 계산기를 홈 화면에 추가하면 일반 앱처럼 바로 열 수 있습니다. 실시간 시세 확인에는 인터넷 연결이 필요합니다.</p>
        <p className="install-notice"><strong>자동 다운로드와는 다릅니다.</strong> 웹사이트가 임의로 앱을 설치할 수는 없으므로 마지막 설치 또는 추가 확인은 사용자가 직접 눌러야 합니다.</p>
        <nav className="install-jump" aria-label="기기별 설치 안내">
          <a href="#iphone">iPhone</a>
          <a href="#android">Android</a>
          <a href="#desktop">PC</a>
        </nav>
      </header>

      <div className="install-guide-grid">
        <article className="install-guide-card" id="iphone">
          <header>
            <span>iPhone · iPad</span>
            <h2>Safari에서 추가</h2>
          </header>
          <ol className="install-steps">
            {iphoneSteps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/install/iphone-guide-v1.png"
            width="1080"
            height="1920"
            alt="Safari의 더 보기, 공유, 메뉴 펼치기, 홈 화면에 추가, 추가 버튼을 차례대로 표시한 다섯 단계 안내"
          />
          <div className="install-guide-actions">
            <a href="/install/iphone-guide-v1.png" download="bitcoin-p2p-iphone-install-guide.png">iPhone 안내 이미지 저장</a>
          </div>
        </article>

        <article className="install-guide-card" id="android">
          <header>
            <span>Android</span>
            <h2>Chrome에서 설치</h2>
          </header>
          <ol className="install-steps">
            {androidSteps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/install/android-guide-v1.png"
            width="1080"
            height="1920"
            alt="Chrome의 더 보기, 설치 및 바로가기 만들기, 설치 버튼을 차례대로 표시한 세 단계 안내"
          />
          <div className="install-guide-actions">
            <a href="/install/android-guide-v1.png" download="bitcoin-p2p-android-install-guide.png">Android 안내 이미지 저장</a>
          </div>
        </article>
      </div>

      <section className="install-desktop" id="desktop">
        <h2>PC에서 설치</h2>
        <p>Chrome·Edge처럼 PWA 설치를 지원하는 브라우저에서는 주소창의 설치 아이콘이나 브라우저 메뉴의 앱 설치 항목을 선택하세요. 설치 신호가 준비되면 계산기 안의 <strong>홈 화면에 추가</strong> 버튼을 눌러 실제 브라우저 설치창을 열 수도 있습니다.</p>
      </section>

      <aside className="install-caveat">
        <strong>설치 메뉴가 보이지 않나요?</strong><br />
        이미 설치되어 있거나, 현재 브라우저가 PWA 설치를 지원하지 않거나, 앱 안 브라우저에서 링크를 연 경우일 수 있습니다. iPhone은 Safari, Android는 Chrome으로 다시 열어 확인해 주세요.
      </aside>
    </main>
  );
}
