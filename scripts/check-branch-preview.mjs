#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { extractReferencedAssets } from "./smoke-deployment.mjs";

const DEFAULT_BASE_URL = "https://staging-bitcoin-p2p-check.thumbking-btc.workers.dev";
const DEFAULT_WAIT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;
const BUILD_ORIGIN = "https://build-artifact.invalid";

function fail(message) {
  throw new Error(message);
}

function fingerprintedAssets(html, pageUrl) {
  return extractReferencedAssets(html, pageUrl)
    .filter((asset) => asset.path.startsWith("/_next/static/")
      && (asset.mediaType === "css" || asset.mediaType === "javascript"))
    .map((asset) => `${asset.mediaType}:${asset.path}`)
    .sort();
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForMatchingPreview(baseUrl, expectedAssets, waitMs) {
  const deadline = Date.now() + waitMs;
  let lastReason = "아직 확인하지 못했습니다.";

  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/`, {
        headers: { Accept: "text/html" },
      });
      if (response.status !== 200) {
        lastReason = `루트 응답 상태 ${response.status}`;
      } else if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
        lastReason = `루트 Content-Type ${response.headers.get("content-type") ?? "없음"}`;
      } else {
        const html = await response.text();
        const deployedAssets = fingerprintedAssets(html, `${baseUrl}/`);
        if (sameList(deployedAssets, expectedAssets)) return html;
        lastReason = `현재 fingerprinted asset 집합이 검증한 빌드와 다릅니다. 예상 ${expectedAssets.length}개, 실제 ${deployedAssets.length}개`;
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  fail(`Cloudflare 브랜치 프리뷰가 ${Math.round(waitMs / 1000)}초 안에 현재 빌드와 일치하지 않았습니다: ${lastReason}`);
}

async function validateDeployedAssets(baseUrl, html) {
  const assets = extractReferencedAssets(html, `${baseUrl}/`)
    .filter((asset) => asset.mediaType === "css" || asset.mediaType === "javascript");
  const cssAssets = assets.filter((asset) => asset.mediaType === "css");
  if (cssAssets.length === 0) fail("배포된 루트 HTML이 CSS asset을 참조하지 않습니다.");

  let coreCssFound = false;
  for (const asset of assets) {
    const response = await fetchWithTimeout(asset.url, {
      headers: { Accept: asset.mediaType === "css" ? "text/css" : "text/javascript" },
    });
    if (response.status !== 200) {
      fail(`배포된 ${asset.mediaType} asset이 200이 아닙니다: ${asset.path} -> ${response.status}`);
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const expectedType = asset.mediaType === "css" ? "text/css" : "javascript";
    if (!contentType.includes(expectedType)) {
      fail(`배포된 ${asset.mediaType} asset의 Content-Type이 잘못되었습니다: ${asset.path} -> ${contentType || "없음"}`);
    }
    const body = await response.text();
    if (body.length === 0) fail(`배포된 ${asset.mediaType} asset이 비어 있습니다: ${asset.path}`);
    if (asset.mediaType === "css" && body.includes(".trade-tool") && body.includes(".capture-card")) {
      coreCssFound = true;
    }
  }

  if (!coreCssFound) {
    fail("배포된 CSS에서 계산기 핵심 UI 스타일(.trade-tool, .capture-card)을 찾지 못했습니다.");
  }
}

async function validateEnvironment(baseUrl) {
  const response = await fetchWithTimeout(`${baseUrl}/api/version`, {
    headers: { Accept: "application/json" },
  });
  if (response.status !== 200) fail(`/api/version 응답이 200이 아닙니다: ${response.status}`);
  const value = await response.json();
  const environment = value?.deploymentEnvironment;
  if (environment === "production") {
    fail("브랜치 프리뷰가 production 환경으로 보고됩니다. 실제 거래 환경과 격리된 preview/staging 설정을 사용해야 합니다.");
  }
  if (environment !== "preview" && environment !== "staging") {
    fail(`브랜치 프리뷰의 배포 환경을 확인할 수 없습니다: ${String(environment)}`);
  }
  console.log(`브랜치 프리뷰 환경 확인: ${environment}`);
}

async function main() {
  const baseUrl = (process.env.PREVIEW_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const waitMs = Number(process.env.PREVIEW_WAIT_MS || DEFAULT_WAIT_MS);
  if (!Number.isFinite(waitMs) || waitMs < 10_000 || waitMs > 15 * 60_000) {
    fail("PREVIEW_WAIT_MS는 10초 이상 15분 이하이어야 합니다.");
  }

  const localHtml = await readFile("dist/client/index.html", "utf8");
  const expectedAssets = fingerprintedAssets(localHtml, `${BUILD_ORIGIN}/`);
  if (!expectedAssets.some((value) => value.startsWith("css:"))) {
    fail("검증한 빌드의 루트 HTML에 fingerprinted CSS asset이 없습니다.");
  }
  if (!expectedAssets.some((value) => value.startsWith("javascript:"))) {
    fail("검증한 빌드의 루트 HTML에 fingerprinted JavaScript asset이 없습니다.");
  }

  console.log(`Cloudflare 브랜치 프리뷰가 현재 빌드(${expectedAssets.length}개 fingerprinted asset)와 일치하기를 기다립니다: ${baseUrl}`);
  const deployedHtml = await waitForMatchingPreview(baseUrl, expectedAssets, waitMs);
  await validateDeployedAssets(baseUrl, deployedHtml);
  await validateEnvironment(baseUrl);
  console.log(`Cloudflare 브랜치 프리뷰 정적 무결성 검증 통과: ${baseUrl}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
