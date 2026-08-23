import { handleLightningAddressRequest } from "./lightning-address";
import { handleLightningPayRequest } from "./lightning-pay";
import { handleMarketRequest } from "./market";

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(
    request: Request,
    _environment: unknown,
    context: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/market" || url.pathname === "/api/market/") {
      return handleMarketRequest(request, context);
    }

    if (url.pathname === "/api/lightning-address" || url.pathname === "/api/lightning-address/") {
      return handleLightningAddressRequest(request);
    }

    if (url.pathname === "/api/lightning-pay" || url.pathname === "/api/lightning-pay/") {
      return handleLightningPayRequest(request);
    }

    return new Response("Not found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};
