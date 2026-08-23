import { handleLightningAddressRequest } from "./lightning-address";
import { handleLightningPayRequest } from "./lightning-pay";
import { handleMarketRequest } from "./market";

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerEnvironment {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

export default {
  async fetch(
    request: Request,
    environment: WorkerEnvironment,
    context: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/market" || url.pathname === "/api/market/") {
      const receiveMode = url.searchParams.get("receive");
      if (request.method === "POST" && receiveMode === "lightning-address") {
        return handleLightningAddressRequest(request);
      }
      if (request.method === "POST" && receiveMode === "lightning-pay") {
        return handleLightningPayRequest(request);
      }
      return handleMarketRequest(request, context);
    }

    if (url.pathname === "/api/lightning-address" || url.pathname === "/api/lightning-address/") {
      return handleLightningAddressRequest(request);
    }

    if (url.pathname === "/api/lightning-pay" || url.pathname === "/api/lightning-pay/") {
      return handleLightningPayRequest(request);
    }

    return environment.ASSETS.fetch(request);
  },
};
