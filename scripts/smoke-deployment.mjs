#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 60_000;

export const SMOKE_ENDPOINTS = Object.freeze([
  Object.freeze({ path: "/", status: 200, mediaType: "text/html", cache: "static-revalidate", security: "html-csp" }),
  Object.freeze({ path: "/install/", status: 200, mediaType: "text/html", cache: "static-revalidate", security: "html-csp" }),
  Object.freeze({ path: "/privacy/", status: 200, mediaType: "text/html", cache: "static-revalidate", security: "html-csp" }),
  Object.freeze({ path: "/verify/", status: 200, mediaType: "text/html", cache: "static-revalidate", security: "html-csp" }),
  Object.freeze({ path: "/sw.js", status: 200, mediaType: "text/javascript", cache: "no-store", security: "service-worker" }),
  Object.freeze({ path: "/api/version", status: 200, mediaType: "application/json", cache: "no-store", validate: "version" }),
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
  return {
    help: false,
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    timeoutMs,
    ...(expectedAppVersion ? { expectedAppVersion } : {}),
    ...(expectedWorkerTag ? { expectedWorkerTag } : {}),
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

export function validateSmokeResponse(endpoint, response) {
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
  if (endpoint.cache === "no-store" && !hasDirective(cacheControl, "no-store")) {
    throw new Error(`Cache-Control에 no-store가 없습니다: ${cacheControl}`);
  }
  if (
    endpoint.cache === "static-revalidate"
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
  return value;
}

async function readSmallJson(response, maximumBytes = 16_384) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new Error(`JSON 응답이 ${maximumBytes} bytes를 초과합니다.`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new Error(`JSON 응답이 ${maximumBytes} bytes를 초과합니다.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("JSON 응답을 해석하지 못했습니다.");
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
    const headers = validateSmokeResponse(endpoint, response);
    const value = endpoint.validate === "version"
      ? validateVersionPayload(await readSmallJson(response), expectations)
      : undefined;
    return { ...headers, ...(value ? { value } : {}) };
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
    if (response?.body) await response.body.cancel().catch(() => undefined);
  }
}

export async function runDeploymentSmoke({
  baseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetcher = fetch,
  log = console.log,
  expectedAppVersion,
  expectedWorkerTag,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const results = [];
  const expectations = { expectedAppVersion, expectedWorkerTag };

  for (const endpoint of SMOKE_ENDPOINTS) {
    const headers = await checkEndpoint(normalizedBaseUrl, endpoint, timeoutMs, fetcher, expectations);
    results.push({ endpoint, ...headers });
    log(`[PASS] GET ${endpoint.path} -> ${endpoint.status}; ${headers.contentType}; Cache-Control: ${headers.cacheControl}`);
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
