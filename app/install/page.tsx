/* eslint-disable @next/next/no-html-link-for-pages -- Vinext static export currently breaks next/link navigation. */
import type { Metadata } from "next";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "홈 화면에 추가하기 | 비트코인 P2P 계산기",
  description: "iPhone Safari와 Android Chrome에서 비트코인 P2P 계산기를 홈 화면에 추가하는 방법입니다.",
  alternates: {
    canonical: "/install",
  },
  openGraph: {
    title: "비트코인 P2P 계산기 홈 화면에 추가하기",
    description: "필요한 기기의 설치 단계를 확인하거나 안내 이미지를 저장해 전달하세요.",
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
  "Safari 아래쪽의 더 보기(…)를 누릅니다.",
  "빠른 메뉴에서 공유를 누릅니다. 공유 아이콘이 바로 보이면 그것을 눌러도 됩니다.",
  "공유 창에서 더 보기를 누릅니다. ‘간략히 보기’라고 표시된다면 이미 펼쳐진 상태입니다.",
  "펼친 목록에서 홈 화면에 추가를 누릅니다.",
  "‘웹 앱으로 열기’가 켜져 있는지 확인하고 오른쪽 위 추가를 누릅니다.",
];

const androidSteps = [
  "오른쪽 위 더 보기(⋮)를 누릅니다.",
  "메뉴를 아래로 내려 설치 및 바로가기 만들기를 누릅니다.",
  "확인 창에서 설치를 누릅니다.",
];

export default function InstallPage() {
  return (
    <main className="install-page">
      <a className="install-back" href="/">← 계산기로 돌아가기</a>

      <header className="install-heading">
        <p className="section-label">비트코인 P2P 계산기 · PWA</p>
        <h1><span>홈 화면에</span>{" "}<span>추가하기</span></h1>
        <p className="install-heading-copy">자주 사용한다면 홈 화면에 추가해 앱처럼 바로 열 수 있습니다. 실시간 시세 확인에는 인터넷 연결이 필요합니다.</p>
        <p className="install-notice"><strong>자동 설치가 아닙니다.</strong> 아래 안내에 따라 마지막 추가·설치 버튼을 직접 눌러 주세요.</p>
        <nav className="install-jump" aria-label="기기별 설치 안내">
          <a href="#iphone"><span>iPhone</span><small>Safari</small></a>
          <a href="#android"><span>Android</span><small>Chrome</small></a>
        </nav>
      </header>

      <div className="install-guide-grid">
        <article className="install-guide-card" id="iphone">
          <header>
            <span>iPhone</span>
            <h2>Safari에서 추가</h2>
          </header>
          <p className="install-platform-note"><strong>Discord·X 같은 앱 안에서 열었나요?</strong> 먼저 Safari로 연 뒤 진행하세요.</p>
          <ol className="install-steps">
            {iphoneSteps.map((step, index) => (
              <li key={step}><span className="visually-hidden">{index + 1}단계. </span>{step}</li>
            ))}
          </ol>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/install/iphone-guide-v1.png"
            width="1080"
            height="1920"
            alt="Safari의 더 보기, 공유, 더 보기, 홈 화면에 추가, 추가 버튼을 차례대로 표시한 안내"
          />
          <div className="install-guide-actions">
            <a href="/install/iphone-guide-v1.png" download="bitcoin-p2p-iphone-install-guide.png">iPhone 안내 이미지 저장</a>
          </div>
          <a className="install-official-link" href="https://support.apple.com/ko-kr/guide/iphone/iphea86e5236/ios" target="_blank" rel="noreferrer">Apple 공식 안내 보기 ↗</a>
        </article>

        <article className="install-guide-card" id="android">
          <header>
            <span>Android</span>
            <h2>Chrome에서 설치</h2>
          </header>
          <p className="install-platform-note"><strong>앱 안 브라우저에서 열었나요?</strong> 먼저 Chrome으로 연 뒤 진행하세요.</p>
          <ol className="install-steps">
            {androidSteps.map((step, index) => (
              <li key={step}><span className="visually-hidden">{index + 1}단계. </span>{step}</li>
            ))}
          </ol>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/install/android-guide-v1.png"
            width="1080"
            height="1920"
            alt="Chrome의 더 보기, 설치 및 바로가기 만들기, 설치 버튼을 차례대로 표시한 안내"
          />
          <div className="install-guide-actions">
            <a href="/install/android-guide-v1.png" download="bitcoin-p2p-android-install-guide.png">Android 안내 이미지 저장</a>
          </div>
          <a className="install-official-link" href="https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&amp;hl=ko" target="_blank" rel="noreferrer">Chrome 공식 안내 보기 ↗</a>
        </article>
      </div>

      <aside className="install-caveat" aria-label="설치 안내 참고사항">
        <strong>설치 메뉴가 보이지 않나요?</strong>
        <p>브라우저 버전과 화면 배치에 따라 이름이나 위치가 달라질 수 있습니다. iPhone의 공유 창이 펼쳐져 있으면 ‘더 보기’ 대신 ‘간략히 보기’가 표시됩니다. Android에서는 ‘앱 설치’ 또는 ‘홈 화면에 추가’로 보일 수 있으며, 이미 설치했다면 설치 메뉴가 보이지 않을 수 있습니다.</p>
        <p className="install-online-note"><strong>인터넷 연결이 필요합니다.</strong> 이 계산기는 홈 화면에서 앱처럼 열 수 있지만 실시간 시세는 온라인에서 확인합니다.</p>
      </aside>
    </main>
  );
}
