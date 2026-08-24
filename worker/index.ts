import { handleMarketRequest } from "./market";
import {
  handleTradeRecordRequest,
  isTradeRecordApiPath,
  type TradeRecordEnvironment,
} from "./trade-record";

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type WorkerEnvironment = TradeRecordEnvironment;

export default {
  async fetch(
    request: Request,
    environment: WorkerEnvironment,
    context: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/market" || url.pathname === "/api/market/") {
      return handleMarketRequest(request, context);
    }

    if (isTradeRecordApiPath(url.pathname)) {
      return handleTradeRecordRequest(request, environment);
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
