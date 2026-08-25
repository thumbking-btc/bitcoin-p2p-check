import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const clientDirectory = path.join(projectRoot, "dist", "client");

async function collectHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectHtmlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(entryPath);
    }
  }

  return files;
}

function cspHash(value) {
  return `'sha256-${createHash("sha256").update(value).digest("base64")}'`;
}

function collectInlineHashes(html, tagName) {
  const hashes = [];
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, "gi");

  for (const match of html.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    if (tagName === "script" && /\bsrc\s*=/i.test(attributes)) continue;
    if (body.length > 0) hashes.push(cspHash(body));
  }

  return hashes;
}

function assertNoInlineAttributes(html, file) {
  for (const match of html.matchAll(/<[a-z][^>]*>/gi)) {
    const tag = match[0];
    if (/\sstyle\s*=/i.test(tag)) {
      throw new Error(`CSP를 우회하는 style 속성이 남아 있습니다: ${file}`);
    }
    if (/\son[a-z]+\s*=/i.test(tag)) {
      throw new Error(`CSP를 우회하는 inline event handler가 남아 있습니다: ${file}`);
    }
  }
}

const htmlFiles = await collectHtmlFiles(clientDirectory);
if (htmlFiles.length === 0) throw new Error("dist/client에 정적 HTML이 없습니다.");

const scriptHashes = new Set();
const styleHashes = new Set();

for (const file of htmlFiles) {
  const html = await readFile(file, "utf8");
  assertNoInlineAttributes(html, path.relative(projectRoot, file));
  collectInlineHashes(html, "script").forEach((hash) => scriptHashes.add(hash));
  collectInlineHashes(html, "style").forEach((hash) => styleHashes.add(hash));
}

const scriptSource = ["'self'", ...[...scriptHashes].sort()].join(" ");
const styleSource = ["'self'", ...[...styleHashes].sort()].join(" ");
const csp = [
  "default-src 'self'",
  `script-src ${scriptSource}`,
  "script-src-attr 'none'",
  `style-src ${styleSource}`,
  "style-src-attr 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' wss://api.upbit.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

if (csp.includes("unsafe-inline") || /[\r\n]/u.test(csp) || csp.length > 16_384) {
  throw new Error("생성된 CSP 정책의 안전성 또는 크기 제한을 확인하십시오.");
}

const headers = `/*
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Origin-Agent-Cluster: ?1
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()

/sw.js
  Cache-Control: no-cache, no-store, must-revalidate
  Service-Worker-Allowed: /

/csp-policy.txt
  Cache-Control: no-cache, no-store, must-revalidate

/manifest.webmanifest
  Cache-Control: public, max-age=3600

/favicon-v2.svg
  Cache-Control: public, max-age=31536000, immutable

/icons/*-v2.png
  Cache-Control: public, max-age=31536000, immutable

/og-v2.png
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: image/png

/_next/static/*
  Cache-Control: public, max-age=31536000, immutable

/install/*.png
  Cache-Control: public, max-age=3600

/api/*
  Cache-Control: no-store
`;

await Promise.all([
  writeFile(path.join(clientDirectory, "_headers"), headers, "utf8"),
  writeFile(path.join(clientDirectory, "csp-policy.txt"), `${csp}\n`, "utf8"),
]);
console.log(`CSP 생성 완료: Worker 응답 정책 ${csp.length}자, script hash ${scriptHashes.size}개, style hash ${styleHashes.size}개`);
