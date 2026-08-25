import { handleMarketRequest } from "./market";
import type { LightningRequestEnvironment } from "./lightning-rate-limit";
import { APP_VERSION } from "../app/lib/app-version";
import {
  handleTradeRecordRequest,
  isTradeRecordApiPath,
  type TradeRecordEnvironment,
} from "./trade-record";

export type WorkerExecutionContext = Pick<ExecutionContext, "waitUntil">;

export type WorkerEnvironment = TradeRecordEnvironment
  & LightningRequestEnvironment
  & Partial<Pick<Env, "ASSETS" | "WORKER_VERSION">>;

const CSP_POLICY_PATH = "/csp-policy.txt";
const MAX_CSP_POLICY_LENGTH = 16_384;
const STATIC_SECURITY_HEADERS = Object.freeze({
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
});

function staticHeaders(source: HeadersInit, pathname: string): Headers {
  const headers = new Headers(source);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) headers.set(name, value);

  if (pathname === "/sw.js") {
    headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    headers.set("Content-Type", "text/javascript; charset=utf-8");
    headers.set("Service-Worker-Allowed", "/");
  } else if (pathname === CSP_POLICY_PATH) {
    headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
  } else if (pathname === "/manifest.webmanifest" || /^\/install\/[^/]+\.png$/u.test(pathname)) {
    headers.set("Cache-Control", "public, max-age=3600");
  } else if (
    pathname === "/favicon-v2.svg"
    || pathname === "/og-v2.png"
    || /^\/icons\/[^/]+-v2\.png$/u.test(pathname)
    || pathname.startsWith("/_next/static/")
  ) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  if (pathname === "/og-v2.png") headers.set("Content-Type", "image/png");
  return headers;
}

function staticAssetFailure(): Response {
  return new Response("Static content is temporarily unavailable", {
    status: 503,
    headers: staticHeaders({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Content-Type": "text/plain; charset=utf-8",
    }, "/"),
  });
}

export async function staticAssetResponse(request: Request, environment: WorkerEnvironment): Promise<Response> {
  if (!environment.ASSETS) return staticAssetFailure();
  const response = await environment.ASSETS.fetch(request);
  const pathname = new URL(request.url).pathname;
  const headers = staticHeaders(response.headers, pathname);
  const htmlResponse = response.headers.get("content-type")?.toLowerCase().startsWith("text/html") ?? false;

  if (htmlResponse) {
    const policyRequest = new Request(new URL(CSP_POLICY_PATH, request.url), {
      headers: { Accept: "text/plain" },
    });
    const policyResponse = await environment.ASSETS.fetch(policyRequest);
    if (!policyResponse.ok) return staticAssetFailure();
    const policy = (await policyResponse.text()).trim();
    if (
      policy.length === 0
      || policy.length > MAX_CSP_POLICY_LENGTH
      || policy.includes("unsafe-inline")
      || /[\r\n]/u.test(policy)
      || !/\bscript-src\b[^;]*'sha256-/u.test(policy)
    ) {
      return staticAssetFailure();
    }
    headers.set("Content-Security-Policy", policy);
  }

  const bodyForbidden = request.method === "HEAD" || response.status === 204 || response.status === 304;
  return new Response(bodyForbidden ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function versionResponse(request: Request, environment: WorkerEnvironment): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "GET 요청만 허용합니다." }, {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const body = request.method === "HEAD" ? null : JSON.stringify({
    ok: true,
    appVersion: APP_VERSION,
    workerVersion: environment.WORKER_VERSION ?? null,
  });
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function apiNotFoundResponse(): Response {
  return Response.json({
    ok: false,
    code: "NOT_FOUND",
    message: "요청한 API 경로를 찾지 못했습니다.",
  }, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(
    request: Request,
    environment: WorkerEnvironment,
    context: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/version" || url.pathname === "/api/version/") {
      return versionResponse(request, environment);
    }

    if (url.pathname === "/api/market" || url.pathname === "/api/market/") {
      return handleMarketRequest(request, context, environment);
    }

    if (isTradeRecordApiPath(url.pathname)) {
      return handleTradeRecordRequest(request, environment);
    }

    if (url.pathname.startsWith("/api/")) return apiNotFoundResponse();

    return staticAssetResponse(request, environment);
  },
};
