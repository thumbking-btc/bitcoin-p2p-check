import { handleMarketRequest } from "./market.ts";
import type { LightningRequestEnvironment } from "./lightning-rate-limit.ts";
import { APP_VERSION } from "../app/lib/app-version.ts";
import { normalizeDeploymentEnvironment } from "../app/lib/deployment-environment.mjs";
import { loadValidatedCspPolicy } from "./csp-policy.ts";
import {
  handleTradeRecordRequest,
  isTradeRecordApiPath,
  type TradeRecordEnvironment,
} from "./trade-record.ts";

export { TradeRecordState } from "./trade-record-state.ts";

export type WorkerExecutionContext = Pick<ExecutionContext, "exports" | "waitUntil">;

export type WorkerEnvironment = TradeRecordEnvironment
  & LightningRequestEnvironment
  & Partial<Pick<Env, "ASSETS" | "WORKER_VERSION">>;

const CSP_POLICY_PATH = "/csp-policy.txt";
const NON_PRODUCTION_ROBOTS_POLICY = "noindex, nofollow, noarchive";
const STAGING_NOTICE_MESSAGE = "전체 기능 검수 환경입니다. 기록은 시험용 저장소에 보관됩니다. 실제 송금은 하지 마십시오.";
const PREVIEW_NOTICE_MESSAGE = "화면 검수 환경입니다. 거래 기록·공유는 전체 기능 검수 환경에서 시험할 수 있습니다.";
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

function staticHeaders(
  source: HeadersInit,
  pathname: string,
  deploymentEnvironment: ReturnType<typeof normalizeDeploymentEnvironment>,
): Headers {
  const headers = new Headers(source);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) headers.set(name, value);
  headers.set("X-Deployment-Environment", deploymentEnvironment);
  if (deploymentEnvironment !== "production") {
    headers.set("X-Robots-Tag", NON_PRODUCTION_ROBOTS_POLICY);
  }

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

function nonProductionHtmlResponse(
  response: Response,
  deploymentEnvironment: ReturnType<typeof normalizeDeploymentEnvironment>,
): Response {
  const label = deploymentEnvironment === "staging"
    ? "STAGING"
    : deploymentEnvironment === "preview" ? "PREVIEW" : "NON-PRODUCTION";

  return new HTMLRewriter()
    .on("html", {
      element(element) {
        element.setAttribute("data-deployment-environment", deploymentEnvironment);
      },
    })
    .on("#deployment-environment-notice", {
      element(element) {
        element.removeAttribute("hidden");
        element.setAttribute("class", "deployment-notice");
        element.setAttribute("data-deployment-environment", deploymentEnvironment);
        element.setAttribute("role", "status");
      },
    })
    .on("#deployment-environment-notice [data-deployment-label]", {
      element(element) {
        element.setInnerContent(label);
      },
    })
    .on("#deployment-environment-notice [data-deployment-message]", {
      element(element) {
        element.setInnerContent(
          deploymentEnvironment === "staging" ? STAGING_NOTICE_MESSAGE : PREVIEW_NOTICE_MESSAGE,
        );
      },
    })
    .transform(response);
}

function staticAssetFailure(environment?: WorkerEnvironment): Response {
  const deploymentEnvironment = normalizeDeploymentEnvironment(environment?.DEPLOYMENT_ENV);
  return new Response("Static content is temporarily unavailable", {
    status: 503,
    headers: staticHeaders({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Content-Type": "text/plain; charset=utf-8",
    }, "/", deploymentEnvironment),
  });
}

export async function staticAssetResponse(request: Request, environment: WorkerEnvironment): Promise<Response> {
  if (!environment.ASSETS) return staticAssetFailure(environment);
  const response = await environment.ASSETS.fetch(request);
  const pathname = new URL(request.url).pathname;
  const deploymentEnvironment = normalizeDeploymentEnvironment(environment.DEPLOYMENT_ENV);
  const headers = staticHeaders(response.headers, pathname, deploymentEnvironment);
  const htmlResponse = response.headers.get("content-type")?.toLowerCase().startsWith("text/html") ?? false;

  if (htmlResponse) {
    if (deploymentEnvironment !== "production") {
      headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    }
    const policyRequest = new Request(new URL(CSP_POLICY_PATH, request.url), {
      headers: { Accept: "text/plain" },
    });
    const policy = await loadValidatedCspPolicy(
      () => environment.ASSETS!.fetch(policyRequest),
      response.body,
    );
    if (!policy) return staticAssetFailure(environment);
    headers.set("Content-Security-Policy", policy);
  }

  const bodyForbidden = request.method === "HEAD" || response.status === 204 || response.status === 304;
  const securedResponse = new Response(bodyForbidden ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  if (htmlResponse && !bodyForbidden && deploymentEnvironment !== "production") {
    return nonProductionHtmlResponse(securedResponse, deploymentEnvironment);
  }
  return securedResponse;
}

export function versionResponse(request: Request, environment: WorkerEnvironment): Response {
  const deploymentEnvironment = normalizeDeploymentEnvironment(environment.DEPLOYMENT_ENV);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "GET 요청만 허용합니다." }, {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        "Cache-Control": "no-store",
        "X-Deployment-Environment": deploymentEnvironment,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const body = request.method === "HEAD" ? null : JSON.stringify({
    ok: true,
    appVersion: APP_VERSION,
    deploymentEnvironment,
    workerVersion: environment.WORKER_VERSION ?? null,
  });
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Deployment-Environment": deploymentEnvironment,
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
      return handleTradeRecordRequest(request, environment, {
        stateNamespace: context.exports.TradeRecordState,
      });
    }

    if (url.pathname.startsWith("/api/")) return apiNotFoundResponse();

    return staticAssetResponse(request, environment);
  },
} satisfies ExportedHandler<Env>;
