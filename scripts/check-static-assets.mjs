#!/usr/bin/env node

import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { extractReferencedAssets } from "./smoke-deployment.mjs";

const DIST_ROOT = path.resolve("dist/client");
const BUILD_ORIGIN = "https://build-artifact.invalid";

function fail(message) {
  throw new Error(message);
}

async function listHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listHtmlFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(absolute);
  }
  return files;
}

function pageUrlFor(htmlPath) {
  const relative = path.relative(DIST_ROOT, htmlPath).split(path.sep).join("/");
  if (relative === "index.html") return `${BUILD_ORIGIN}/`;
  if (relative.endsWith("/index.html")) {
    return `${BUILD_ORIGIN}/${relative.slice(0, -"index.html".length)}`;
  }
  return `${BUILD_ORIGIN}/${relative}`;
}

function localPathFor(assetUrl) {
  const url = new URL(assetUrl);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const absolute = path.resolve(DIST_ROOT, relative);
  if (absolute !== DIST_ROOT && !absolute.startsWith(`${DIST_ROOT}${path.sep}`)) {
    fail(`정적 asset 경로가 dist/client 밖을 가리킵니다: ${url.pathname}`);
  }
  return absolute;
}

async function main() {
  const htmlFiles = await listHtmlFiles(DIST_ROOT);
  if (htmlFiles.length === 0) fail("dist/client에 HTML 산출물이 없습니다.");

  const rootHtmlPath = path.join(DIST_ROOT, "index.html");
  const rootHtml = await readFile(rootHtmlPath, "utf8");
  const rootAssets = extractReferencedAssets(rootHtml, `${BUILD_ORIGIN}/`);
  if (!rootAssets.some((asset) => asset.mediaType === "css")) {
    fail("루트 HTML이 CSS asset을 참조하지 않습니다.");
  }
  if (!rootAssets.some((asset) => asset.mediaType === "javascript")) {
    fail("루트 HTML이 JavaScript asset을 참조하지 않습니다.");
  }

  const assets = new Map();
  for (const htmlPath of htmlFiles) {
    const html = await readFile(htmlPath, "utf8");
    for (const asset of extractReferencedAssets(html, pageUrlFor(htmlPath))) {
      const previous = assets.get(asset.path);
      if (previous && previous.mediaType !== asset.mediaType) {
        fail(`같은 asset이 서로 다른 형식으로 참조됩니다: ${asset.path}`);
      }
      assets.set(asset.path, asset);
    }
  }

  const cssBodies = [];
  for (const asset of assets.values()) {
    const localPath = localPathFor(asset.url);
    let metadata;
    try {
      metadata = await stat(localPath);
    } catch {
      fail(`HTML이 참조하는 정적 asset이 빌드 산출물에 없습니다: ${asset.path}`);
    }
    if (!metadata.isFile() || metadata.size <= 0) {
      fail(`HTML이 참조하는 정적 asset이 비어 있거나 파일이 아닙니다: ${asset.path}`);
    }
    if (asset.mediaType === "css") cssBodies.push(await readFile(localPath, "utf8"));
  }

  if (cssBodies.length === 0) fail("검증할 CSS 산출물을 찾지 못했습니다.");
  if (!cssBodies.some((body) => body.includes(".trade-tool") && body.includes(".capture-card"))) {
    fail("빌드된 CSS에서 계산기 핵심 UI 스타일(.trade-tool, .capture-card)을 찾지 못했습니다.");
  }

  console.log(`정적 asset 산출물 검증 통과: HTML ${htmlFiles.length}개, 직접 참조 asset ${assets.size}개, CSS ${cssBodies.length}개`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
