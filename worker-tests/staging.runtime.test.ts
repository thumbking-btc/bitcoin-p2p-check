import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("staging Worker isolation and identification", () => {
  it("has isolated state, a staging signer, and all staging rate limits", () => {
    const bindings = env as unknown as Record<string, unknown>;
    expect(Object.hasOwn(bindings, "TRADE_RECORDS")).toBe(false);
    expect(Object.hasOwn(bindings, "TRADE_RECORD_SIGNING_KEY")).toBe(true);
    expect(Object.hasOwn(bindings, "TRADE_RECORD_CREATE_RATE_LIMITER")).toBe(true);
    expect(Object.hasOwn(bindings, "TRADE_RECORD_READ_RATE_LIMITER")).toBe(true);
    expect(bindings.DEPLOYMENT_ENV).toBe("staging");
    expect(bindings.TRADE_RECORDS_ENABLED).toBe("true");
  });

  it("marks HTML and version metadata as non-production", async () => {
    const page = await exports.default.fetch("https://staging.test/");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(page.headers.get("x-deployment-environment")).toBe("staging");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    const html = await page.text();
    const notice = html.match(/<aside[^>]*id="deployment-environment-notice"[^>]*>/u)?.[0] ?? "";
    expect(html).toContain("<html lang=\"ko\" data-deployment-environment=\"staging\"");
    expect(notice).not.toContain("hidden");
    expect(notice).toContain("data-deployment-environment=\"staging\"");
    expect(html).toContain(">STAGING<");
    expect(html).toContain("전체 기능 검수 환경입니다. 기록은 시험용 저장소에 보관됩니다. 실제 송금은 하지 마십시오.");

    const version = await exports.default.fetch("https://staging.test/api/version");
    expect(version.headers.get("cache-control")).toBe("no-store");
    expect(version.headers.get("x-deployment-environment")).toBe("staging");
    await expect(version.json()).resolves.toMatchObject({
      ok: true,
      appVersion: "2.3.1",
      deploymentEnvironment: "staging",
    });
  });

  it("routes record mutations to isolated Durable Object state", async () => {
    const id = "AAAAAAAAAAAAAAAA";
    const headers = { "CF-Connecting-IP": "203.0.113.47" };
    const read = await exports.default.fetch(new Request(`https://staging.test/api/trade-record/${id}`, { headers }));
    const create = await exports.default.fetch(new Request("https://staging.test/api/trade-record", { method: "POST", headers }));
    const finalize = await exports.default.fetch(new Request(`https://staging.test/api/trade-record/${id}/finalize`, { method: "POST", headers }));
    const remove = await exports.default.fetch(new Request(`https://staging.test/api/trade-record/${id}`, { method: "DELETE", headers }));

    expect(read.status).toBe(404);
    expect(create.status).toBe(400);
    expect(finalize.status).toBe(401);
    expect(remove.status).toBe(401);
    await expect(create.json()).resolves.toMatchObject({ ok: false, code: "IDEMPOTENCY_KEY_REQUIRED" });
    await expect(finalize.json()).resolves.toMatchObject({ ok: false, code: "INVALID_CAPABILITY" });
    await expect(remove.json()).resolves.toMatchObject({ ok: false, code: "INVALID_CAPABILITY" });
  });

  it("keeps a staging-only Lightning limiter available without external requests", async () => {
    const response = await exports.default.fetch(new Request(
      "https://staging.test/api/market?receive=lightning-pay",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.47",
          "Content-Type": "text/plain; foo=application/json",
        },
        body: "{}",
      },
    ));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });
});
