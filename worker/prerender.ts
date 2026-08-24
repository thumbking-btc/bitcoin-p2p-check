import vinextHandler from "vinext/server/app-router-entry";
import { handleMarketRequest } from "./market";
import type { WorkerEnvironment, WorkerExecutionContext } from "./index";
import { handleTradeRecordRequest, isTradeRecordApiPath } from "./trade-record";

type FetchHandler = {
  fetch(request: Request, environment: unknown, context: unknown): Promise<Response> | Response;
};

const handler = vinextHandler as FetchHandler;

export default {
  fetch(request: Request, environment: unknown, context: unknown) {
    const url = new URL(request.url);

    if (url.pathname === "/api/market" || url.pathname === "/api/market/") {
      return handleMarketRequest(request, context as WorkerExecutionContext);
    }

    if (isTradeRecordApiPath(url.pathname)) {
      return handleTradeRecordRequest(request, environment as WorkerEnvironment);
    }

    // vinext beta.2 asks the un-slashed route while exporting, while its own
    // trailingSlash middleware redirects that request. Canonicalizing only the
    // build-time page request avoids the 308 and still emits install/index.html.
    if (url.pathname === "/install" || url.pathname === "/verify" || url.pathname === "/_not-found") {
      url.pathname += "/";
      request = new Request(url.toString(), request);
    }

    return handler.fetch(request, environment, context);
  },
};
