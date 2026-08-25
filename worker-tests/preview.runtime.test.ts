import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("preview Worker isolation", () => {
  it("has no production trade-record KV or signing secret", () => {
    const bindings = env as unknown as Record<string, unknown>;
    expect(Object.hasOwn(bindings, "TRADE_RECORDS")).toBe(false);
    expect(Object.hasOwn(bindings, "TRADE_RECORD_SIGNING_KEY")).toBe(false);
    expect(bindings.DEPLOYMENT_ENV).toBe("preview");
    expect(bindings.TRADE_RECORDS_ENABLED).toBe("false");
  });

  it("fails closed before binding access for every record mutation", async () => {
    const id = "AAAAAAAAAAAAAAAA";
    const read = await exports.default.fetch(`https://preview.test/api/trade-record/${id}`);
    const create = await exports.default.fetch(new Request("https://preview.test/api/trade-record", { method: "POST" }));
    const finalize = await exports.default.fetch(new Request(`https://preview.test/api/trade-record/${id}/finalize`, { method: "POST" }));
    const remove = await exports.default.fetch(new Request(`https://preview.test/api/trade-record/${id}`, { method: "DELETE" }));

    expect(read.status).toBe(404);
    expect(create.status).toBe(503);
    expect(finalize.status).toBe(503);
    expect(remove.status).toBe(503);
    await expect(create.json()).resolves.toMatchObject({ ok: false, code: "TRADE_RECORDS_DISABLED" });
    await expect(finalize.json()).resolves.toMatchObject({ ok: false, code: "TRADE_RECORDS_DISABLED" });
    await expect(remove.json()).resolves.toMatchObject({ ok: false, code: "TRADE_RECORDS_DISABLED" });
  });

  it("keeps a separate Lightning limiter available without external requests", async () => {
    const response = await exports.default.fetch(new Request(
      "https://preview.test/api/market?receive=lightning-pay",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.46",
          "Content-Type": "text/plain; foo=application/json",
        },
        body: "{}",
      },
    ));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });
});
