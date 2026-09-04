#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { extractReferencedAssets } from "./smoke-deployment.mjs";

const DEFAULT_WAIT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;
const BUILD_ORIGIN = "https://build-artifact.invalid";
const CLOUDFLARE_BOT = "cloudflare-workers-and-pages[bot]";
const CLOUDFLARE_WORKER_NAME = "bitcoin-p2p-check";
const CLOUDFLARE_WORKERS_SUBDOMAIN = "thumbking-btc";

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

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function describeAssetMismatch(expectedAssets, deployedAssets) {
  const expectedOnly = difference(expectedAssets, deployedAssets);
  const deployedOnly = difference(deployedAssets, expectedAssets);
  return [
    `현재 fingerprinted asset 집합이 검증한 빌드와 다릅니다. 예상 ${expectedAssets.length}개, 실제 ${deployedAssets.length}개`,
    `검증 빌드에만 있음: ${expectedOnly.length > 0 ? expectedOnly.join(", ") : "없음"}`,
    `Cloudflare 프리뷰에만 있음: ${deployedOnly.length > 0 ? deployedOnly.join(", ") : "없음"}`,
  ].join(" | ");
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

function validatePreviewUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("Cloudflare 커밋 프리뷰 URL 형식을 해석할 수 없습니다.");
  }
  const suffix = `-${CLOUDFLARE_WORKER_NAME}.${CLOUDFLARE_WORKERS_SUBDOMAIN}.workers.dev`;
  const prefix = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : "";
  if (url.protocol !== "https:"
    || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(prefix)
    || url.port
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash) {
    fail(`허용되지 않은 Cloudflare 커밋 프리뷰 URL입니다: ${rawUrl}`);
  }
  return url.origin;
}

export function extractCloudflareCommitPreviewUrl(comments, expectedSha) {
  if (!Array.isArray(comments)) fail("GitHub PR 댓글 응답이 배열이 아닙니다.");
  if (!/^[0-9a-f]{40}$/u.test(expectedSha)) fail("검증할 Git 커밋 SHA가 올바르지 않습니다.");
  const shortSha = expectedSha.slice(0, 8);

  for (const comment of [...comments].reverse()) {
    if (comment?.user?.login !== CLOUDFLARE_BOT || typeof comment?.body !== "string") continue;
    const rowMarker = `| ${CLOUDFLARE_WORKER_NAME} | ${shortSha} |`;
    if (!comment.body.includes(rowMarker)) continue;
    const match = /<a href=['"](https:\/\/[^'"]+)['"]>Commit Preview URL<\/a>/u.exec(comment.body);
    if (!match) fail(`Cloudflare 봇 댓글이 ${shortSha} 커밋을 가리키지만 커밋 Preview URL이 없습니다.`);
    return validatePreviewUrl(match[1]);
  }
  return null;
}

async function fetchPullRequestComments(repository, pullRequestNumber, token) {
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${repository}/issues/${pullRequestNumber}/comments?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bitcoin-p2p-check-preview-verifier",
      },
    },
  );
  if (response.status !== 200) fail(`GitHub PR 댓글 조회가 실패했습니다: HTTP ${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) fail(`GitHub PR 댓글 응답이 JSON이 아닙니다: ${contentType || "없음"}`);
  return response.json();
}

async function waitForExactCommitPreview(waitMs) {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const expectedSha = process.env.GITHUB_SHA ?? "";
  const pullRequestNumber = process.env.GITHUB_PR_NUMBER ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) fail("GITHUB_REPOSITORY가 올바르지 않습니다.");
  if (!/^[0-9a-f]{40}$/u.test(expectedSha)) fail("GITHUB_SHA가 올바르지 않습니다.");
  if (!/^[1-9]\d*$/u.test(pullRequestNumber)) fail("GITHUB_PR_NUMBER가 올바르지 않습니다.");
  if (!token) fail("Cloudflare 커밋 프리뷰를 찾으려면 읽기 전용 GITHUB_TOKEN이 필요합니다.");

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const comments = await fetchPullRequestComments(repository, pullRequestNumber, token);
    const previewUrl = extractCloudflareCommitPreviewUrl(comments, expectedSha);
    if (previewUrl) return previewUrl;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  fail(`Cloudflare 봇이 ${Math.round(waitMs / 1000)}초 안에 현재 커밋 ${expectedSha.slice(0, 8)}의 Preview URL을 게시하지 않았습니다.`);
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
        lastReason = describeAssetMismatch(expectedAssets, deployedAssets);
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  fail(`Cloudflare 커밋 프리뷰가 ${Math.round(waitMs / 1000)}초 안에 현재 빌드와 일치하지 않았습니다: ${lastReason}`);
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
    fail("커밋 프리뷰가 production 환경으로 보고됩니다. 실제 거래 환경과 격리된 preview/staging 설정을 사용해야 합니다.");
  }
  if (environment !== "preview" && environment !== "staging") {
    fail(`커밋 프리뷰의 배포 환경을 확인할 수 없습니다: ${String(environment)}`);
  }
  console.log(`커밋 프리뷰 환경 확인: ${environment}`);
}

async function main() {
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

  const override = process.env.PREVIEW_BASE_URL?.trim();
  const baseUrl = override ? validatePreviewUrl(override) : await waitForExactCommitPreview(waitMs);
  console.log(`현재 커밋의 Cloudflare 프리뷰를 검증합니다: ${baseUrl}`);
  const deployedHtml = await waitForMatchingPreview(baseUrl, expectedAssets, waitMs);
  await validateDeployedAssets(baseUrl, deployedHtml);
  await validateEnvironment(baseUrl);
  console.log(`Cloudflare 커밋 프리뷰 정적 무결성 검증 통과: ${baseUrl}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
