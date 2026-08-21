import vinextHandler from "vinext/server/app-router-entry";
import { handleMarketRequest } from "./market";

type FetchHandler = {
  fetch(request: Request, environment: Env, context: ExecutionContext): Promise<Response> | Response;
};

const handler = vinextHandler as FetchHandler;

export default {
  fetch(request: Request, environment: Env, context: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/api/market" || url.pathname === "/api/market/") {
      return handleMarketRequest(request, context);
    }

    // Vinext asks the un-slashed route while exporting, while its own
    // trailingSlash middleware redirects that request. Canonicalizing only the
    // build-time page request avoids the 308 and still emits install/index.html.
    if (url.pathname === "/install" || url.pathname === "/_not-found") {
      url.pathname += "/";
      request = new Request(url.toString(), request);
    }

    return handler.fetch(request, environment, context);
  },
} satisfies ExportedHandler<Env>;
