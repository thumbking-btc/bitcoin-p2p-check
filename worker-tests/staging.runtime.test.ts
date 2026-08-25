import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("staging Worker isolation and identification", () => {
  it("has no production trade-record KV or signing secret", () => {
    const bindings = env as unknown as Record<string, unknown>;
    expect(Object.hasOwn(bindings, "TRADE_RECORDS")).toBe(false);
    expect(Object.hasOwn(bindings, "TRADE_RECORD_SIGNING_KEY")).toBe(false);
    expect(bindings.DEPLOYMENT_ENV).toBe("staging");
    expect(bindings.TRADE_RECORDS_ENABLED).toBe("false");
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
    expect(html).toContain("시험 환경입니다. 서버 거래 기록 저장 기능은 비활성화되어 있습니다.");

    const version = await exports.default.fetch("https://staging.test/api/version");
    expect(version.headers.get("cache-control")).toBe("no-store");
    expect(version.headers.get("x-deployment-environment")).toBe("staging");
    await expect(version.json()).resolves.toMatchObject({
      ok: true,
      appVersion: "2.3.0",
      deploymentEnvironment: "staging",
    });
  });

  it("fails closed before binding access for every record mutation", async () => {
    const id = "AAAAAAAAAAAAAAAA";
    const read = await exports.default.fetch(`https://staging.test/api/trade-record/${id}`);
    const create = await exports.default.fetch(new Request("https://staging.test/api/trade-record", { method: "POST" }));
    const finalize = await exports.default.fetch(new Request(`https://staging.test/api/trade-record/${id}/finalize`, { method: "POST" }));
    const remove = await exports.default.fetch(new Request(`https://staging.test/api/trade-record/${id}`, { method: "DELETE" }));

    expect(read.status).toBe(404);
    expect(create.status).toBe(503);
    expect(finalize.status).toBe(503);
    expect(remove.status).toBe(503);
    await expect(create.json()).resolves.toMatchObject({ ok: false, code: "TRADE_RECORDS_DISABLED" });
    await expect(finalize.json()).resolves.toMatchObject({ ok: false, code: "TRADE_RECORDS_DISABLED" });
    await expect(remove.json()).resolves.toMatchObject({ ok: false, code: "TRADE_RECORDS_DISABLED" });
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
