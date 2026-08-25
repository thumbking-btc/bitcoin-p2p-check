#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { init as initModuleLexer, parse as parseModuleImports } from "es-module-lexer";

await initModuleLexer;
import { normalizeDeploymentEnvironment } from "../app/lib/deployment-environment.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 60_000;
const MAX_HTML_BYTES = 512 * 1_024;
const MAX_TEXT_ASSET_BYTES = 2 * 1_024 * 1_024;
const MAX_REFERENCED_ASSETS = 128;

export const SMOKE_ENDPOINTS = Object.freeze([
  Object.freeze({ path: "/api/version", status: 200, mediaType: "application/json", cache: "no-store", validate: "version" }),
  Object.freeze({ path: "/", status: 200, mediaType: "text/html", cache: "static-revalidate", security: "html-csp", validate: "html-assets" }),
  Object.freeze({ path: "/install/", status: 200, mediaType: "text/html", cache: "static-revalidate", security: "html-csp", validate: "html-assets" }),
  Object.freeze({ path: "/privacy/", status: 200, mediaType: "text/html", cache: "static-revalidate", security: "html-csp", validate: "html-assets" }),
  Object.freeze({ path: "/verify/", status: 200, mediaType: "text/html", cache: "static-revalidate", security: "html-csp", validate: "html-assets" }),
  Object.freeze({ path: "/sw.js", status: 200, mediaType: "text/javascript", cache: "no-store", security: "service-worker", validate: "service-worker-assets" }),
  Object.freeze({ path: "/api/market?price=0", status: 200, mediaType: "application/json", cache: "no-store" }),
  Object.freeze({ path: "/api/trade-record/AAAAAAAAAAAAAAAB", status: 404, mediaType: "application/json", cache: "no-store" }),
  Object.freeze({ path: "/api/unknown", status: 404, mediaType: "application/json", cache: "no-store" }),
]);

export function smokeUsage() {
  return [
    "사용법:",
    "  node scripts/smoke-deployment.mjs https://example.com",
    "  node scripts/smoke-deployment.mjs --base-url https://example.com",
    "  BASE_URL=https://example.com node scripts/smoke-deployment.mjs",
    "",
    "선택 사항: --timeout-ms <10..60000> 또는 SMOKE_TIMEOUT_MS 환경 변수를 사용하십시오.",
    "환경 고정: --expected-environment <production|staging|preview> 또는 EXPECTED_DEPLOYMENT_ENV를 사용하십시오.",
    "버전 고정: --expected-worker-version-id <id> 또는 EXPECTED_WORKER_VERSION_ID를 사용하십시오.",
  ].join("\n");
}

function requireArgument(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} 값을 입력하십시오.`);
  return value;
}

export function parseSmokeOptions(argv = process.argv.slice(2), environment = process.env) {
  let baseUrlArgument;
  let timeoutArgument;
  let expectedEnvironmentArgument;
  let expectedWorkerVersionIdArgument;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--base-url") {
      baseUrlArgument = requireArgument(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--base-url=")) {
      baseUrlArgument = argument.slice("--base-url=".length);
      continue;
    }
    if (argument === "--timeout-ms") {
      timeoutArgument = requireArgument(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--timeout-ms=")) {
      timeoutArgument = argument.slice("--timeout-ms=".length);
      continue;
    }
    if (argument === "--expected-environment") {
      expectedEnvironmentArgument = requireArgument(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--expected-environment=")) {
      expectedEnvironmentArgument = argument.slice("--expected-environment=".length);
      continue;
    }
    if (argument === "--expected-worker-version-id") {
      expectedWorkerVersionIdArgument = requireArgument(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--expected-worker-version-id=")) {
      expectedWorkerVersionIdArgument = argument.slice("--expected-worker-version-id=".length);
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    if (baseUrlArgument) throw new Error("BASE_URL은 한 번만 입력하십시오.");
    baseUrlArgument = argument;
  }

  const rawBaseUrl = baseUrlArgument ?? environment.BASE_URL;
  if (!rawBaseUrl) throw new Error(`BASE_URL이 필요합니다.\n\n${smokeUsage()}`);

  const rawTimeout = timeoutArgument ?? environment.SMOKE_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number(rawTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeout은 ${MIN_TIMEOUT_MS}~${MAX_TIMEOUT_MS}ms 정수여야 합니다.`);
  }

  const expectedAppVersion = environment.EXPECTED_APP_VERSION?.trim();
  const expectedWorkerTag = environment.EXPECTED_WORKER_TAG?.trim();
  const expectedWorkerVersionId = expectedWorkerVersionIdArgument
    ?? environment.EXPECTED_WORKER_VERSION_ID?.trim();
  const rawExpectedEnvironment = expectedEnvironmentArgument ?? environment.EXPECTED_DEPLOYMENT_ENV?.trim();
  const expectedDeploymentEnvironment = rawExpectedEnvironment
    ? normalizeDeploymentEnvironment(rawExpectedEnvironment)
    : undefined;
  if (rawExpectedEnvironment && expectedDeploymentEnvironment === "unknown") {
    throw new Error("expected environment는 production, staging 또는 preview여야 합니다.");
  }
  return {
    help: false,
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    timeoutMs,
    ...(expectedAppVersion ? { expectedAppVersion } : {}),
    ...(expectedWorkerTag ? { expectedWorkerTag } : {}),
    ...(expectedWorkerVersionId ? { expectedWorkerVersionId } : {}),
    ...(expectedDeploymentEnvironment ? { expectedDeploymentEnvironment } : {}),
  };
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BASE_URL은 유효한 절대 URL이어야 합니다.");
  }

  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("BASE_URL은 HTTPS여야 합니다. 로컬 루프백 검사에만 HTTP를 사용할 수 있습니다.");
  }
  if (url.username || url.password) throw new Error("BASE_URL에 사용자 이름이나 비밀번호를 포함하지 마십시오.");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("BASE_URL에는 경로, 쿼리 또는 fragment를 포함하지 마십시오.");
  }
  return url.origin;
}

function hasDirective(value, name) {
  return value.split(",").some((part) => part.trim().toLowerCase() === name);
}

function hasZeroMaxAge(value) {
  return value.split(",").some((part) => /^max-age\s*=\s*0$/iu.test(part.trim()));
}

export function validateSmokeResponse(endpoint, response, expectations = {}) {
  if (response.status !== endpoint.status) {
    throw new Error(`예상 상태 ${endpoint.status}, 실제 상태 ${response.status}`);
  }

  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== endpoint.mediaType) {
    throw new Error(`예상 Content-Type ${endpoint.mediaType}, 실제 ${contentType ?? "없음"}`);
  }

  const cacheControl = response.headers.get("cache-control");
  if (!cacheControl) throw new Error("Cache-Control 헤더가 없습니다.");
  const expectedDeploymentEnvironment = normalizeDeploymentEnvironment(
    expectations.expectedDeploymentEnvironment,
  );
  const nonProductionHtml = endpoint.security === "html-csp"
    && expectedDeploymentEnvironment !== "unknown"
    && expectedDeploymentEnvironment !== "production";
  const expectedCache = nonProductionHtml ? "no-store" : endpoint.cache;
  if (expectedCache === "no-store" && !hasDirective(cacheControl, "no-store")) {
    throw new Error(`Cache-Control에 no-store가 없습니다: ${cacheControl}`);
  }
  if (
    expectedCache === "static-revalidate"
    && (!hasDirective(cacheControl, "public")
      || !hasZeroMaxAge(cacheControl)
      || !hasDirective(cacheControl, "must-revalidate")
      || hasDirective(cacheControl, "immutable"))
  ) {
    throw new Error(`정적 HTML 캐시 정책이 public, max-age=0, must-revalidate가 아닙니다: ${cacheControl}`);
  }
  if (endpoint.security === "html-csp") {
    const csp = response.headers.get("content-security-policy") ?? "";
    if (!/\bscript-src\b[^;]*'sha256-/u.test(csp) || csp.includes("unsafe-inline")) {
      throw new Error("정적 HTML 응답에 hash 기반 CSP가 적용되지 않았습니다.");
    }
    const requiredHeaders = {
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "origin-agent-cluster": "?1",
    };
    for (const [name, expected] of Object.entries(requiredHeaders)) {
      if (response.headers.get(name) !== expected) throw new Error(`정적 HTML 보안 헤더가 다릅니다: ${name}`);
    }
    if (!response.headers.get("strict-transport-security")?.includes("max-age=31536000")) {
      throw new Error("정적 HTML에 HSTS가 없습니다.");
    }
    if (!response.headers.get("permissions-policy")?.includes("camera=()")) {
      throw new Error("정적 HTML에 Permissions-Policy가 없습니다.");
    }
    if (expectedDeploymentEnvironment !== "unknown") {
      const responseEnvironment = response.headers.get("x-deployment-environment");
      if (responseEnvironment !== expectedDeploymentEnvironment) {
        throw new Error(`정적 HTML 환경 헤더가 다릅니다: 예상 ${expectedDeploymentEnvironment}, 실제 ${responseEnvironment ?? "없음"}`);
      }
      const robots = response.headers.get("x-robots-tag")?.toLowerCase() ?? "";
      if (expectedDeploymentEnvironment === "production" && robots.includes("noindex")) {
        throw new Error("프로덕션 HTML에 noindex가 적용되어 있습니다.");
      }
      if (expectedDeploymentEnvironment !== "production"
        && (!robots.includes("noindex") || !robots.includes("nofollow") || !robots.includes("noarchive"))) {
        throw new Error(`비프로덕션 HTML의 X-Robots-Tag가 안전하지 않습니다: ${robots || "없음"}`);
      }
    }
  }
  if (endpoint.security === "service-worker" && response.headers.get("service-worker-allowed") !== "/") {
    throw new Error("서비스 워커 scope 헤더가 없습니다.");
  }

  return { contentType, cacheControl };
}

export function validateVersionPayload(value, expectations = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.ok !== true) {
    throw new Error("/api/version 응답 형식을 확인하지 못했습니다.");
  }
  if (typeof value.appVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.appVersion)) {
    throw new Error("/api/version의 appVersion을 확인하지 못했습니다.");
  }
  const deploymentEnvironment = normalizeDeploymentEnvironment(value.deploymentEnvironment);
  if (deploymentEnvironment === "unknown" || value.deploymentEnvironment !== deploymentEnvironment) {
    throw new Error("/api/version의 deploymentEnvironment를 확인하지 못했습니다.");
  }
  if (value.workerVersion !== null && (
    typeof value.workerVersion !== "object"
    || Array.isArray(value.workerVersion)
    || typeof value.workerVersion.id !== "string"
    || typeof value.workerVersion.tag !== "string"
    || typeof value.workerVersion.timestamp !== "string"
  )) {
    throw new Error("/api/version의 Worker version metadata를 확인하지 못했습니다.");
  }
  if (expectations.expectedAppVersion && value.appVersion !== expectations.expectedAppVersion) {
    throw new Error(`배포 앱 버전이 다릅니다: 예상 ${expectations.expectedAppVersion}, 실제 ${value.appVersion}`);
  }
  if (expectations.expectedWorkerTag && value.workerVersion?.tag !== expectations.expectedWorkerTag) {
    throw new Error(`배포 Worker tag가 다릅니다: 예상 ${expectations.expectedWorkerTag}, 실제 ${value.workerVersion?.tag ?? "없음"}`);
  }
  if (expectations.expectedWorkerVersionId && value.workerVersion?.id !== expectations.expectedWorkerVersionId) {
    throw new Error(`배포 Worker version ID가 다릅니다: 예상 ${expectations.expectedWorkerVersionId}, 실제 ${value.workerVersion?.id ?? "없음"}`);
  }
  if (expectations.expectedDeploymentEnvironment
    && deploymentEnvironment !== expectations.expectedDeploymentEnvironment) {
    throw new Error(`배포 환경이 다릅니다: 예상 ${expectations.expectedDeploymentEnvironment}, 실제 ${deploymentEnvironment}`);
  }
  return value;
}

async function readSmallText(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new Error(`응답이 ${maximumBytes} bytes를 초과합니다.`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new Error(`응답이 ${maximumBytes} bytes를 초과합니다.`);
  }
  return text;
}

function cancelWithoutWaiting(cancel) {
  try {
    void cancel().catch(() => undefined);
  } catch {
    // Cleanup must never delay or replace the smoke result.
  }
}

async function readSmallJson(response, maximumBytes = 16_384) {
  const text = await readSmallText(response, maximumBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("JSON 응답을 해석하지 못했습니다.");
  }
}

function quotedAttributes(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/\b([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function addReferencedAsset(assets, asset) {
  if (!asset) return;
  const existing = assets.get(asset.path);
  if (existing && existing.mediaType !== asset.mediaType) {
    throw new Error(`같은 asset이 서로 다른 형식으로 참조됩니다: ${asset.path}`);
  }
  assets.set(asset.path, asset);
  if (assets.size > MAX_REFERENCED_ASSETS) {
    throw new Error(`asset 참조가 ${MAX_REFERENCED_ASSETS}개를 초과합니다.`);
  }
}

function createReferencedAsset(candidate, baseUrl, mediaType) {
  let assetUrl;
  try {
    assetUrl = new URL(candidate, baseUrl);
  } catch {
    throw new Error(`asset URL이 올바르지 않습니다: ${candidate}`);
  }
  if (assetUrl.protocol !== "http:" && assetUrl.protocol !== "https:") return null;
  if (assetUrl.origin !== new URL(baseUrl).origin) return null;
  if (assetUrl.username || assetUrl.password) throw new Error("asset URL에 자격 증명이 포함되어 있습니다.");
  assetUrl.hash = "";
  const resolvedMediaType = typeof mediaType === "function" ? mediaType(assetUrl) : mediaType;
  if (!resolvedMediaType) throw new Error(`asset 형식을 추론하지 못했습니다: ${assetUrl.pathname}`);
  const assetPath = `${assetUrl.pathname}${assetUrl.search}`;
  return Object.freeze({ path: assetPath, url: assetUrl.href, mediaType: resolvedMediaType });
}

function inferStaticMediaType(assetUrl, defaultMediaType) {
  const pathname = assetUrl.pathname.toLowerCase();
  if (/\.(?:m?js)$/u.test(pathname)) return "javascript";
  if (/\.css$/u.test(pathname)) return "css";
  if (/\.(?:webmanifest|manifest)$/u.test(pathname)) return "manifest";
  if (/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/u.test(pathname)) return "image";
  if (/\.(?:eot|otf|ttf|woff2?)$/u.test(pathname)) return "font";
  return defaultMediaType;
}

export function extractReferencedAssets(html, pageUrl) {
  if (typeof html !== "string") throw new TypeError("HTML은 문자열이어야 합니다.");
  const baseUrl = new URL(pageUrl);
  const assets = new Map();

  for (const match of html.matchAll(/<(script|link|img)\b[^>]{0,4096}>/giu)) {
    const tagName = match[1].toLowerCase();
    const attributes = quotedAttributes(match[0]);
    let candidate;
    let mediaType;

    if (tagName === "script") {
      candidate = attributes.get("src");
      mediaType = "javascript";
    } else if (tagName === "img") {
      candidate = attributes.get("src");
      mediaType = "image";
    } else {
      const rel = attributes.get("rel")?.toLowerCase().split(/\s+/u) ?? [];
      candidate = attributes.get("href");
      if (rel.includes("stylesheet")) {
        mediaType = "css";
      } else if (rel.includes("modulepreload")) {
        mediaType = "javascript";
      } else if (rel.includes("manifest")) {
        mediaType = "manifest";
      } else if (rel.includes("icon") || rel.includes("apple-touch-icon")) {
        mediaType = "image";
      } else if (rel.includes("preload")) {
        const preloadType = attributes.get("as")?.toLowerCase();
        mediaType = preloadType === "script" ? "javascript"
          : preloadType === "style" ? "css"
            : preloadType === "image" ? "image"
              : preloadType === "font" ? "font"
                : undefined;
      }
    }
    if (!candidate || !mediaType) continue;
    addReferencedAsset(
      assets,
      createReferencedAsset(candidate.replaceAll("&amp;", "&"), baseUrl, mediaType),
    );
  }

  return Object.freeze([...assets.values()]);
}

function requireLiteralSpecifier(quote, value) {
  if (value.includes("\\") || (quote === "`" && value.includes("${"))) {
    throw new Error("정적으로 해석할 수 없는 JavaScript asset specifier가 있습니다.");
  }
  return value;
}

export function extractJavaScriptReferencedAssets(source, sourceUrl) {
  if (typeof source !== "string") throw new TypeError("JavaScript는 문자열이어야 합니다.");
  const assets = new Map();

  let imports;
  try {
    [imports] = parseModuleImports(source, sourceUrl);
  } catch {
    throw new Error("JavaScript module specifier를 해석하지 못했습니다.");
  }
  for (const imported of imports) {
    if (imported.d === -2) continue;
    if (imported.n === undefined) {
      throw new Error("정적으로 해석할 수 없는 dynamic import가 있습니다.");
    }
    addReferencedAsset(assets, createReferencedAsset(imported.n, sourceUrl, "javascript"));
  }
  for (const match of source.matchAll(/\bimportScripts\s*\(\s*(["'`])([^"'`\r\n]+)\1\s*\)/gu)) {
    addReferencedAsset(
      assets,
      createReferencedAsset(requireLiteralSpecifier(match[1], match[2]), sourceUrl, "javascript"),
    );
  }
  return Object.freeze([...assets.values()]);
}

export function extractCssReferencedAssets(source, sourceUrl) {
  if (typeof source !== "string") throw new TypeError("CSS는 문자열이어야 합니다.");
  const assets = new Map();
  for (const match of source.matchAll(/@import\s*(["'])([^"'\r\n]+)\1/giu)) {
    addReferencedAsset(assets, createReferencedAsset(match[2], sourceUrl, "css"));
  }
  for (const match of source.matchAll(/\burl\(\s*(?:(["'])([^"']+)\1|([^)'"\s][^)]*?))\s*\)/giu)) {
    const candidate = (match[2] ?? match[3] ?? "").trim();
    if (!candidate || candidate.startsWith("#")) continue;
    addReferencedAsset(
      assets,
      createReferencedAsset(candidate, sourceUrl, (assetUrl) => inferStaticMediaType(assetUrl)),
    );
  }
  return Object.freeze([...assets.values()]);
}

export function extractManifestReferencedAssets(source, sourceUrl) {
  if (typeof source !== "string") throw new TypeError("manifest는 문자열이어야 합니다.");
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error("web manifest JSON을 해석하지 못했습니다.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("web manifest가 객체가 아닙니다.");
  }

  const assets = new Map();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && typeof value.src === "string") {
      addReferencedAsset(assets, createReferencedAsset(value.src, sourceUrl, "image"));
    }
    for (const nested of Array.isArray(value) ? value : Object.values(value)) visit(nested);
  };
  visit(manifest);
  return Object.freeze([...assets.values()]);
}

export function extractServiceWorkerReferencedAssets(source, sourceUrl) {
  if (typeof source !== "string") throw new TypeError("service worker는 문자열이어야 합니다.");
  const declarations = [...source.matchAll(/\b(?:const|let|var)\s+APP_SHELL\s*=\s*\[([\s\S]{0,32768}?)\]\s*;/gu)];
  if (declarations.length !== 1) throw new Error("service worker APP_SHELL 선언을 정확히 하나 찾지 못했습니다.");

  const body = declarations[0][1];
  const literals = [...body.matchAll(/"(?:\\.|[^"\\])*"/gu)];
  const residual = body.replaceAll(/"(?:\\.|[^"\\])*"/gu, "").replaceAll(/[\s,]/gu, "");
  if (residual || literals.length === 0 || literals.length > MAX_REFERENCED_ASSETS) {
    throw new Error("service worker APP_SHELL을 정적으로 해석하지 못했습니다.");
  }

  const assets = new Map();
  for (const literal of literals) {
    let candidate;
    try {
      candidate = JSON.parse(literal[0]);
    } catch {
      throw new Error("service worker APP_SHELL 문자열을 해석하지 못했습니다.");
    }
    addReferencedAsset(
      assets,
      createReferencedAsset(candidate, sourceUrl, (assetUrl) => inferStaticMediaType(assetUrl, "html")),
    );
  }
  for (const asset of extractJavaScriptReferencedAssets(source, sourceUrl)) addReferencedAsset(assets, asset);
  return Object.freeze([...assets.values()]);
}

export function validateReferencedAssetResponse(asset, response) {
  if (response.status !== 200) {
    throw new Error(`예상 상태 200, 실제 상태 ${response.status}`);
  }
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const mediaTypeAllowed = asset.mediaType === "css"
    ? mediaType === "text/css"
    : asset.mediaType === "javascript"
      ? mediaType === "text/javascript" || mediaType === "application/javascript"
      : asset.mediaType === "image"
        ? mediaType?.startsWith("image/") === true
        : asset.mediaType === "manifest"
          ? mediaType === "application/manifest+json" || mediaType === "application/json"
          : asset.mediaType === "font"
            ? mediaType?.startsWith("font/") === true || mediaType === "application/font-woff" || mediaType === "application/font-woff2"
            : asset.mediaType === "html"
              ? mediaType === "text/html"
              : false;
  if (!mediaTypeAllowed) {
    throw new Error(`예상 ${asset.mediaType} Content-Type, 실제 ${contentType ?? "없음"}`);
  }
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (asset.path.startsWith("/_next/static/")
    && (!hasDirective(cacheControl, "public")
      || !hasDirective(cacheControl, "immutable")
      || !cacheControl.split(",").some((part) => /^max-age\s*=\s*31536000$/iu.test(part.trim())))) {
    throw new Error(`fingerprinted asset 캐시 정책이 public, max-age=31536000, immutable이 아닙니다: ${cacheControl || "없음"}`);
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    throw new Error("정적 asset에 X-Content-Type-Options: nosniff가 없습니다.");
  }
  return { contentType, cacheControl };
}

async function checkReferencedAsset(asset, timeoutMs, fetcher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetcher(asset.url, {
      method: "GET",
      headers: {
        Accept: asset.mediaType === "css" ? "text/css"
          : asset.mediaType === "javascript" ? "text/javascript"
            : asset.mediaType === "image" ? "image/*"
              : asset.mediaType === "manifest" ? "application/manifest+json"
                : asset.mediaType === "html" ? "text/html"
                  : "font/*",
      },
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    const headers = validateReferencedAssetResponse(asset, response);
    const textual = ["javascript", "css", "manifest", "html"].includes(asset.mediaType);
    return {
      ...headers,
      ...(textual ? { body: await readSmallText(response, MAX_TEXT_ASSET_BYTES) } : {}),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`GET ${asset.path} 요청이 ${timeoutMs}ms 안에 완료되지 않았습니다.`, { cause: error });
    }
    throw new Error(
      `GET ${asset.path} 검사에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    if (response?.body) cancelWithoutWaiting(() => response.body.cancel("smoke response cleanup"));
  }
}

async function checkEndpoint(baseUrl, endpoint, timeoutMs, fetcher, expectations) {
  const url = new URL(endpoint.path, `${baseUrl}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Accept: endpoint.mediaType },
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    const headers = validateSmokeResponse(endpoint, response, expectations);
    const value = endpoint.validate === "version"
      ? validateVersionPayload(await readSmallJson(response), expectations)
      : undefined;
    if (value && response.headers.get("x-deployment-environment") !== value.deploymentEnvironment) {
      throw new Error("/api/version의 body와 X-Deployment-Environment 헤더가 다릅니다.");
    }
    const referencedAssets = endpoint.validate === "html-assets"
      ? extractReferencedAssets(await readSmallText(response, MAX_HTML_BYTES), url)
      : endpoint.validate === "service-worker-assets"
        ? extractServiceWorkerReferencedAssets(
          await readSmallText(response, MAX_TEXT_ASSET_BYTES),
          url,
        )
        : undefined;
    if (endpoint.path === "/" && referencedAssets) {
      if (!referencedAssets.some((asset) => asset.mediaType === "javascript")) {
        throw new Error("루트 HTML에서 JavaScript asset을 찾지 못했습니다.");
      }
      if (!referencedAssets.some((asset) => asset.mediaType === "css")) {
        throw new Error("루트 HTML에서 CSS asset을 찾지 못했습니다.");
      }
    }
    return {
      ...headers,
      ...(value ? { value } : {}),
      ...(referencedAssets ? { referencedAssets } : {}),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`GET ${endpoint.path} 요청이 ${timeoutMs}ms 안에 완료되지 않았습니다.`, { cause: error });
    }
    throw new Error(
      `GET ${endpoint.path} 검사에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    if (response?.body) cancelWithoutWaiting(() => response.body.cancel("smoke response cleanup"));
  }
}

function extractNestedAssetReferences(asset, body) {
  if (asset.mediaType === "javascript") return extractJavaScriptReferencedAssets(body, asset.url);
  if (asset.mediaType === "css") return extractCssReferencedAssets(body, asset.url);
  if (asset.mediaType === "manifest") return extractManifestReferencedAssets(body, asset.url);
  if (asset.mediaType === "html") return extractReferencedAssets(body, asset.url);
  return Object.freeze([]);
}

function endpointGraphMediaType(endpoint) {
  if (endpoint.mediaType === "text/html") return "html";
  if (endpoint.mediaType === "text/javascript") return "javascript";
  if (endpoint.mediaType === "application/manifest+json") return "manifest";
  return null;
}

export async function runDeploymentSmoke({
  baseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetcher = fetch,
  log = console.log,
  expectedAppVersion,
  expectedWorkerTag,
  expectedWorkerVersionId,
  expectedDeploymentEnvironment,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const results = [];
  let expectations = {
    expectedAppVersion,
    expectedWorkerTag,
    expectedWorkerVersionId,
    expectedDeploymentEnvironment,
  };
  const validatedEndpointAssets = new Map();
  const queuedAssets = new Map();

  for (const endpoint of SMOKE_ENDPOINTS) {
    const result = await checkEndpoint(normalizedBaseUrl, endpoint, timeoutMs, fetcher, expectations);
    results.push({ endpoint, ...result });
    log(`[PASS] GET ${endpoint.path} -> ${endpoint.status}; ${result.contentType}; Cache-Control: ${result.cacheControl}`);
    const endpointMediaType = endpointGraphMediaType(endpoint);
    if (endpoint.status === 200 && endpointMediaType) validatedEndpointAssets.set(endpoint.path, endpointMediaType);

    if (result.value && !expectations.expectedDeploymentEnvironment) {
      expectations = {
        ...expectations,
        expectedDeploymentEnvironment: result.value.deploymentEnvironment,
      };
    }

    for (const asset of result.referencedAssets ?? []) addReferencedAsset(queuedAssets, asset);
  }

  const assets = [...queuedAssets.values()];
  for (let index = 0; index < assets.length; index += 4) {
    const batch = assets.slice(index, index + 4).filter((asset) => {
      const endpointMediaType = validatedEndpointAssets.get(asset.path);
      if (!endpointMediaType) return true;
      if (endpointMediaType !== asset.mediaType) {
        throw new Error(`검증된 endpoint가 서로 다른 asset 형식으로 참조됩니다: ${asset.path}`);
      }
      return false;
    });
    const batchResults = await Promise.all(batch.map(async (asset) => ({
      asset,
      headers: await checkReferencedAsset(asset, timeoutMs, fetcher),
    })));
    for (const { asset, headers } of batchResults) {
      const { body, ...responseHeaders } = headers;
      results.push({ asset, ...responseHeaders });
      log(`[PASS] GET ${asset.path} -> 200; ${responseHeaders.contentType}; Cache-Control: ${responseHeaders.cacheControl}`);
      for (const nestedAsset of extractNestedAssetReferences(asset, body)) {
        if (validatedEndpointAssets.has(nestedAsset.path)) {
          const endpointMediaType = validatedEndpointAssets.get(nestedAsset.path);
          if (endpointMediaType !== nestedAsset.mediaType) {
            throw new Error(`검증된 endpoint가 서로 다른 asset 형식으로 참조됩니다: ${nestedAsset.path}`);
          }
          continue;
        }
        if (queuedAssets.has(nestedAsset.path)) {
          addReferencedAsset(queuedAssets, nestedAsset);
          continue;
        }
        addReferencedAsset(queuedAssets, nestedAsset);
        assets.push(nestedAsset);
      }
    }
  }

  log(`읽기 전용 배포 스모크를 통과했습니다: ${normalizedBaseUrl}`);
  return results;
}

async function main() {
  const options = parseSmokeOptions();
  if (options.help) {
    console.log(smokeUsage());
    return;
  }
  await runDeploymentSmoke(options);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
