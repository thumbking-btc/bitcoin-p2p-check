import sharp from "sharp";
import { fileURLToPath } from "node:url";

const outputUrl = new URL("../public/og-v2.png", import.meta.url);
const outputPath = fileURLToPath(outputUrl);

// Canonical white mark from bitcoin.org/img/icons/logotop.svg.
// The vector already contains Bitcoin's characteristic 13.88° clockwise tilt.
const bitcoinMarkPath = "m241.91 70.689c0.637-4.258-2.605-6.547-7.038-8.074l1.438-5.768-3.511-0.875-1.4 5.616c-0.923-0.23-1.871-0.447-2.813-0.662l1.41-5.653-3.509-0.875-1.439 5.766c-0.764-0.174-1.514-0.346-2.242-0.527l0.004-0.018-4.842-1.209-0.934 3.75c0 0 2.605 0.597 2.55 0.634 1.422 0.355 1.679 1.296 1.636 2.042l-1.638 6.571c0.098 0.025 0.225 0.061 0.365 0.117-0.117-0.029-0.242-0.061-0.371-0.092l-2.296 9.205c-0.174 0.432-0.615 1.08-1.609 0.834 0.035 0.051-2.552-0.637-2.552-0.637l-1.743 4.019 4.569 1.139c0.85 0.213 1.683 0.436 2.503 0.646l-1.453 5.834 3.507 0.875 1.439-5.772c0.958 0.26 1.888 0.5 2.798 0.726l-1.434 5.745 3.511 0.875 1.453-5.823c5.987 1.133 10.489 0.676 12.384-4.739 1.527-4.36-0.076-6.875-3.226-8.515 2.294-0.529 4.022-2.038 4.483-5.155zm-8.022 11.249c-1.085 4.36-8.426 2.003-10.806 1.412l1.928-7.729c2.38 0.594 10.012 1.77 8.878 6.317zm1.086-11.312c-0.99 3.966-7.1 1.951-9.082 1.457l1.748-7.01c1.982 0.494 8.365 1.416 7.334 5.553z";

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <title>비트코인 P2P 계산기</title>
  <desc>원화와 비트코인 거래 조건을 계산하고 공유하는 계산기 링크 안내 카드</desc>
  <rect width="1200" height="630" fill="#f5f0e3"/>
  <path d="M28 28h1144v574H28z" fill="none" stroke="#101619" stroke-width="4"/>

  <g font-family="Pretendard, Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif">
    <circle cx="67" cy="72" r="22" fill="#f7931a"/>
    <text x="67" y="81" fill="#101619" font-family="Georgia, Times New Roman, serif" font-size="27" font-weight="800" text-anchor="middle">₿</text>
    <text x="102" y="87" fill="#101619" font-size="42" font-weight="800" letter-spacing="-1.2">비트코인 P2P 계산기</text>

    <rect x="930" y="49" width="208" height="52" rx="26" fill="#f7931a"/>
    <text x="1034" y="83" fill="#101619" font-size="24" font-weight="800" text-anchor="middle">계산기 링크</text>

    <rect x="52" y="120" width="1096" height="448" rx="8" fill="#101619"/>
    <rect x="70" y="138" width="1060" height="412" rx="4" fill="none" stroke="#34414a" stroke-width="2"/>
    <path d="M892 166v356" fill="none" stroke="#53616b" stroke-width="2" stroke-dasharray="8 10"/>

    <text x="92" y="187" fill="#b6c0c8" font-size="21" font-weight="700" letter-spacing=".5">비트코인 P2P 거래 조건</text>
    <text x="92" y="279" fill="#f5f0e3" font-size="67" font-weight="800" letter-spacing="-2.4">원화 ↔ 비트코인</text>
    <text x="92" y="334" fill="#f5f0e3" font-size="34" font-weight="700" letter-spacing="-.8">한 화면에서 계산하고 공유</text>

    <path d="M92 372h752" stroke="#53616b" stroke-width="2"/>
    <text x="92" y="417" fill="#d9d1c1" font-size="22" font-weight="650">업비트 시세 · 판매자 프리미엄 · 구매자 자금 출처</text>

    <rect x="92" y="449" width="752" height="58" rx="4" fill="#f7931a"/>
    <text x="468" y="486" fill="#101619" font-size="25" font-weight="800" text-anchor="middle">공유된 조건은 현재 시세로 다시 계산됩니다</text>
    <text x="92" y="536" fill="#b6c0c8" font-size="19" font-weight="600">거래 전 조건을 다시 확인하세요</text>

    <circle cx="1014" cy="332" r="94" fill="#f7931a"/>
    <circle cx="1014" cy="332" r="76" fill="none" stroke="#101619" stroke-width="2" opacity=".22"/>
    <g transform="translate(1014 332) scale(3.25) translate(-227.5 -74)" fill="#fff">
      <path d="${bitcoinMarkPath}"/>
    </g>
    <text x="1014" y="466" fill="#f5f0e3" font-size="24" font-weight="800" text-anchor="middle" letter-spacing="1">KRW ↔ BTC</text>
  </g>
</svg>`;

const result = await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 })
  .toFile(outputPath);

console.log(`Generated ${outputUrl.pathname} (${result.width}×${result.height}, ${result.size} bytes)`);
