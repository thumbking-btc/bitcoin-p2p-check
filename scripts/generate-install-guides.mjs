import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, "../public/install");

const C = {
  paper: "#f4f0e7",
  card: "#fffdf8",
  ink: "#111820",
  muted: "#63707b",
  line: "#c9c1b4",
  soft: "#f1f2f3",
  softer: "#e4e7ea",
  orange: "#f7931a",
  orangeSoft: "#fff1dd",
  red: "#df3327",
  blue: "#1677d2",
  green: "#2cc45a",
  white: "#ffffff",
};

const font = "'Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo',sans-serif";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function text(x, y, value, size = 24, options = {}) {
  const {
    fill = C.ink,
    weight = 600,
    anchor = "start",
    family = font,
    spacing = "-0.5",
  } = options;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${spacing}">${escapeXml(value)}</text>`;
}

function lines(x, y, values, size = 24, gap = 40, options = {}) {
  return values.map((value, index) => text(x, y + index * gap, value, size, options)).join("\n");
}

function rect(x, y, width, height, options = {}) {
  const {
    fill = "none",
    stroke = "none",
    strokeWidth = 0,
    rx = 0,
  } = options;
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function line(x1, y1, x2, y2, options = {}) {
  const { stroke = C.line, strokeWidth = 2, dash = "" } = options;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${strokeWidth}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function highlight(x, y, width, height, rx = 14) {
  return rect(x, y, width, height, {
    fill: C.orangeSoft,
    stroke: C.red,
    strokeWidth: 7,
    rx,
  });
}

function appIcon(x, y, size = 66) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  return [
    rect(x, y, size, size, { fill: C.ink, rx: Math.round(size * 0.23) }),
    `<circle cx="${cx}" cy="${cy}" r="${Math.round(size * 0.34)}" fill="${C.orange}"/>`,
    `<text x="${cx}" y="${cy + size * 0.08}" fill="#fff" font-family="Arial,sans-serif" font-size="${Math.round(size * 0.48)}" font-weight="700" text-anchor="middle" transform="rotate(13.88 ${cx} ${cy})">₿</text>`,
  ].join("\n");
}

function guideHeader(platform, browser, titleValue, subtitle) {
  return `
    ${appIcon(54, 48, 104)}
    ${text(188, 92, `${platform} · ${browser}`, 31, { fill: "#a84b00", weight: 800 })}
    ${text(188, 155, titleValue, 57, { weight: 900, spacing: "-2" })}
    ${text(56, 218, subtitle, 25, { fill: C.muted, weight: 500 })}
  `;
}

function stepBadge(number, x, y) {
  return `
    <circle cx="${x}" cy="${y}" r="28" fill="${C.orange}"/>
    ${text(x, y + 10, String(number), 29, { fill: C.white, weight: 900, anchor: "middle", spacing: "0" })}
  `;
}

function stepCard({ y, height, number, titleValue, body, note = [], preview }) {
  const previewX = 73;
  const previewY = y + 20;
  const previewW = 586;
  const previewH = height - 40;
  const copyX = 710;
  return `
    ${rect(51, y, 978, height, { fill: C.card, stroke: C.line, strokeWidth: 3, rx: 26 })}
    ${rect(previewX, previewY, previewW, previewH, { fill: C.soft, stroke: C.ink, strokeWidth: 4, rx: 22 })}
    <g transform="translate(${previewX} ${previewY})">${preview(previewW, previewH)}</g>
    ${stepBadge(number, copyX + 27, y + 53)}
    ${text(copyX + 67, y + 63, titleValue, 29, { weight: 900, spacing: "-1" })}
    ${lines(copyX, y + 119, body, 24, 41, { weight: 700 })}
    ${note.length ? lines(copyX, y + height - 50 - (note.length - 1) * 31, note, 19, 31, { fill: C.muted, weight: 500 }) : ""}
  `;
}

function footer(message, detail) {
  return `
    ${rect(51, 1742, 978, 126, { fill: C.ink, rx: 24 })}
    ${text(540, 1793, message, 25, { fill: "#ffbf64", weight: 800, anchor: "middle" })}
    ${text(540, 1836, detail, 20, { fill: "#d8d2c7", weight: 500, anchor: "middle" })}
  `;
}

function iphonePreview1(w, h) {
  return `
    ${rect(18, 16, w - 36, h - 32, { fill: C.white, rx: 18 })}
    ${appIcon(38, 31, 46)}
    ${text(100, 66, "비트코인 P2P 계산기", 23, { weight: 850 })}
    ${rect(37, 82, w - 74, 42, { fill: C.ink, rx: 7 })}
    ${rect(37, 137, 218, 45, { fill: "#e8e2d7", rx: 7 })}
    ${rect(269, 137, 280, 45, { fill: "#e8e2d7", rx: 7 })}
    ${rect(18, h - 52, w - 36, 36, { fill: C.softer, rx: 18 })}
    ${text(284, h - 27, "bitcoin-p2p-check…", 16, { fill: C.muted, weight: 600, anchor: "middle" })}
    ${highlight(w - 88, h - 62, 62, 55, 16)}
    ${text(w - 57, h - 25, "•••", 24, { weight: 900, anchor: "middle", spacing: "2" })}
  `;
}

function iphonePreview2(w, h) {
  return `
    ${rect(18, 15, w - 36, h - 30, { fill: C.white, rx: 22 })}
    ${rect(w / 2 - 42, 26, 84, 6, { fill: C.line, rx: 3 })}
    ${text(44, 67, "Safari 메뉴", 23, { weight: 850 })}
    ${line(38, 81, w - 38, 81, { stroke: "#e5dfd5" })}
    ${highlight(36, 90, w - 72, 60, 13)}
    <path d="M68 131v-33m-12 12 12-12 12 12" fill="none" stroke="${C.blue}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    ${rect(51, 107, 34, 31, { stroke: C.blue, strokeWidth: 4, rx: 7 })}
    ${text(106, 130, "공유", 25, { weight: 850 })}
    ${text(54, 183, "북마크에 추가", 21, { fill: C.muted, weight: 550 })}
  `;
}

function iphonePreview3(w, h) {
  return `
    ${rect(18, 15, w - 36, h - 30, { fill: "#3f4246", rx: 22 })}
    ${appIcon(40, 35, 48)}
    ${text(105, 61, "비트코인 P2P 계산기", 20, { fill: C.white, weight: 750 })}
    ${text(105, 88, "bitcoin-p2p-check…", 15, { fill: "#c8cbd0", weight: 500 })}
    ${rect(38, 111, w - 76, 2, { fill: "#585c61" })}
    ${rect(45, 120, 80, 76, { fill: "#68b6ff", rx: 20 })}
    ${rect(145, 120, 80, 76, { fill: "#42c766", rx: 20 })}
    ${rect(245, 120, 80, 76, { fill: "#68b6ff", rx: 20 })}
    ${text(85, 217, "AirDrop", 15, { fill: C.white, weight: 500, anchor: "middle" })}
    ${text(185, 217, "메시지", 15, { fill: C.white, weight: 500, anchor: "middle" })}
    ${text(285, 217, "Mail", 15, { fill: C.white, weight: 500, anchor: "middle" })}
    ${highlight(w - 147, 120, 102, 101, 19)}
    <path d="M${w - 119} 158l18 18 18-18" fill="none" stroke="${C.ink}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    ${text(w - 96, 211, "더 보기", 15, { weight: 750, anchor: "middle" })}
  `;
}

function iphonePreview4(w, h) {
  return `
    ${rect(18, 15, w - 36, h - 30, { fill: "#3f4246", rx: 22 })}
    ${text(47, 52, "공유 메뉴", 22, { fill: C.white, weight: 800 })}
    ${text(w - 48, 52, "간략히 보기", 17, { fill: "#d9dde1", weight: 550, anchor: "end" })}
    ${line(38, 67, w - 38, 67, { stroke: "#595d62" })}
    ${text(54, 104, "즐겨찾기에 추가", 20, { fill: C.white, weight: 600 })}
    ${text(54, 143, "빠른 메모에 추가", 20, { fill: C.white, weight: 600 })}
    ${highlight(38, 155, w - 76, 58, 13)}
    ${rect(53, 170, 28, 28, { stroke: C.ink, strokeWidth: 3, rx: 6 })}
    ${text(67, 192, "+", 27, { weight: 700, anchor: "middle" })}
    ${text(99, 193, "홈 화면에 추가", 22, { weight: 850 })}
  `;
}

function iphonePreview5(w, h) {
  return `
    ${rect(18, 15, w - 36, h - 30, { fill: C.white, rx: 22 })}
    ${text(44, 59, "홈 화면에 추가", 23, { weight: 850 })}
    ${highlight(w - 112, 25, 77, 47, 13)}
    ${text(w - 73, 58, "추가", 22, { fill: C.blue, weight: 850, anchor: "middle" })}
    ${line(38, 82, w - 38, 82, { stroke: "#e5dfd5" })}
    ${appIcon(48, 99, 68)}
    ${text(135, 127, "P2P 계산기", 23, { weight: 800 })}
    ${text(135, 157, "bitcoin-p2p-check…", 16, { fill: C.muted, weight: 500 })}
    ${text(48, 201, "웹 앱으로 열기", 20, { weight: 650 })}
    ${rect(w - 116, 177, 72, 38, { fill: C.green, rx: 19 })}
    <circle cx="${w - 66}" cy="196" r="15" fill="${C.white}"/>
  `;
}

function androidPreview1(w, h) {
  return `
    ${rect(18, 18, w - 36, 58, { fill: C.white, stroke: C.line, strokeWidth: 2, rx: 29 })}
    ${text(44, 57, "bitcoin-p2p-check…", 19, { fill: C.muted, weight: 600 })}
    ${highlight(w - 88, 8, 62, 78, 18)}
    ${text(w - 57, 61, "⋮", 39, { weight: 850, anchor: "middle" })}
    ${rect(18, 97, w - 36, h - 115, { fill: C.white, rx: 18 })}
    ${appIcon(42, 121, 56)}
    ${text(116, 157, "비트코인 P2P 계산기", 24, { weight: 850 })}
    ${rect(42, 184, w - 84, 55, { fill: C.ink, rx: 8 })}
    ${rect(42, 257, 218, 71, { fill: "#e8e2d7", rx: 8 })}
    ${rect(276, 257, 268, 71, { fill: "#e8e2d7", rx: 8 })}
  `;
}

function androidPreview2(w, h) {
  return `
    ${rect(104, 14, w - 122, h - 28, { fill: C.white, stroke: C.line, strokeWidth: 2, rx: 22 })}
    ${text(136, 61, "새 탭", 22, { weight: 650 })}
    ${text(136, 111, "새 시크릿 탭", 22, { weight: 650 })}
    ${line(128, 138, w - 38, 138, { stroke: "#e7e1d7" })}
    ${text(136, 181, "방문 기록", 22, { weight: 650 })}
    ${text(136, 231, "다운로드", 22, { weight: 650 })}
    ${text(136, 281, "공유…", 22, { weight: 650 })}
    ${highlight(120, h - 93, w - 154, 67, 13)}
    ${text(144, h - 50, "설치 및 바로가기 만들기", 21, { weight: 850 })}
    <path d="M${w - 74} ${h - 65}l12 12-12 12" fill="none" stroke="${C.ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  `;
}

function androidPreview3(w, h) {
  return `
    ${rect(50, 57, w - 100, h - 114, { fill: C.white, stroke: C.line, strokeWidth: 2, rx: 28 })}
    ${text(82, 104, "앱 설치", 27, { weight: 850 })}
    ${line(76, 128, w - 76, 128, { stroke: "#e6e0d7" })}
    ${appIcon(82, 157, 72)}
    ${text(177, 187, "비트코인 P2P 계산기", 23, { weight: 800 })}
    ${text(177, 220, "bitcoin-p2p-check…", 17, { fill: C.muted, weight: 500 })}
    ${text(w - 223, h - 104, "취소", 21, { fill: C.muted, weight: 750, anchor: "middle" })}
    ${highlight(w - 176, h - 143, 106, 60, 15)}
    ${text(w - 123, h - 103, "설치", 22, { fill: "#566000", weight: 850, anchor: "middle" })}
  `;
}

function documentSvg({ titleValue, description, body }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(titleValue)}</title>
  <desc id="desc">${escapeXml(description)}</desc>
  <rect width="1080" height="1920" fill="${C.paper}"/>
  ${body}
</svg>`.replace(/[ \t]+$/gm, "");
}

const iphoneSvg = documentSvg({
  titleValue: "iPhone Safari에서 비트코인 P2P 계산기를 홈 화면에 추가하는 방법",
  description: "Safari 더 보기, 공유, 메뉴 펼치기, 홈 화면에 추가, 추가 버튼을 순서대로 안내합니다.",
  body: `
    ${guideHeader("iPhone", "Safari", "홈 화면에 추가하기", "실제 화면의 핵심 버튼만 남겨 순서와 위치를 쉽게 확인할 수 있습니다.")}
    ${stepCard({ y: 258, height: 272, number: 1, titleValue: "더 보기 열기", body: ["Safari 아래쪽의", "… 버튼을 누릅니다."], note: ["공유 아이콘이 바로 보이면", "그것을 눌러도 됩니다."], preview: iphonePreview1 })}
    ${stepCard({ y: 544, height: 272, number: 2, titleValue: "공유 선택", body: ["빠른 메뉴에서", "공유를 누릅니다."], note: ["공유 창이 열립니다."], preview: iphonePreview2 })}
    ${stepCard({ y: 830, height: 272, number: 3, titleValue: "메뉴 펼치기", body: ["공유 창에서", "더 보기를 누릅니다."], note: ["‘간략히 보기’라면", "이미 펼쳐진 상태입니다."], preview: iphonePreview3 })}
    ${stepCard({ y: 1116, height: 272, number: 4, titleValue: "홈 화면에 추가", body: ["펼친 목록에서", "홈 화면에 추가를", "누릅니다."], preview: iphonePreview4 })}
    ${stepCard({ y: 1402, height: 272, number: 5, titleValue: "추가 완료", body: ["웹 앱으로 열기를 확인하고", "오른쪽 위 추가를", "누릅니다."], preview: iphonePreview5 })}
    ${footer("iPhone의 Safari에서 진행하세요.", "브라우저 버전에 따라 버튼 이름과 모양이 조금 다를 수 있습니다.")}
  `,
});

const androidSvg = documentSvg({
  titleValue: "Android Chrome에서 비트코인 P2P 계산기를 설치하는 방법",
  description: "Chrome 더 보기, 설치 및 바로가기 만들기, 설치 버튼을 순서대로 안내합니다.",
  body: `
    ${guideHeader("Android", "Chrome", "홈 화면에 설치하기", "실제 화면의 핵심 버튼만 남겨 순서와 위치를 쉽게 확인할 수 있습니다.")}
    ${stepCard({ y: 272, height: 430, number: 1, titleValue: "더 보기 열기", body: ["Chrome 오른쪽 위의", "⋮ 버튼을 누릅니다."], note: ["주소와 상태표시는", "안내에서 생략했습니다."], preview: androidPreview1 })}
    ${stepCard({ y: 724, height: 430, number: 2, titleValue: "설치 메뉴 선택", body: ["메뉴를 아래로 내려", "설치 및 바로가기", "만들기를 누릅니다."], note: ["기기에 따라 ‘앱 설치’로", "보일 수도 있습니다."], preview: androidPreview2 })}
    ${stepCard({ y: 1176, height: 430, number: 3, titleValue: "설치 완료", body: ["확인 창에서", "설치를 누릅니다."], note: ["이제 홈 화면의 아이콘으로", "계산기를 열 수 있습니다."], preview: androidPreview3 })}
    ${footer("Android의 Chrome에서 진행하세요.", "이미 설치했다면 설치 메뉴가 표시되지 않을 수 있습니다.")}
  `,
});

await mkdir(outputDir, { recursive: true });

for (const [name, svg] of [
  ["iphone-guide", iphoneSvg],
  ["android-guide", androidSvg],
]) {
  const svgPath = path.join(outputDir, `${name}.svg`);
  const pngPath = path.join(outputDir, `${name}-v1.png`);
  await writeFile(svgPath, svg, "utf8");
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toFile(pngPath);
  console.log(`generated ${path.relative(process.cwd(), svgPath)}`);
  console.log(`generated ${path.relative(process.cwd(), pngPath)}`);
}
