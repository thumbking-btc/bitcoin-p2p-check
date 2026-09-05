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

  it("marks HTML and version metadata as non-production", async () => {
    const page = await exports.default.fetch("https://preview.test/");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(page.headers.get("x-deployment-environment")).toBe("preview");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    const html = await page.text();
    const notice = html.match(/<aside[^>]*id="deployment-environment-notice"[^>]*>/u)?.[0] ?? "";
    expect(html).toContain("<html lang=\"ko\" data-deployment-environment=\"preview\"");
    expect(notice).not.toContain("hidden");
    expect(notice).toContain("data-deployment-environment=\"preview\"");
    expect(html).toContain(">PREVIEW<");
    expect(html).toContain("화면 검수 환경입니다. 거래 기록·공유는 전체 기능 검수 환경에서 시험할 수 있습니다.");

    const version = await exports.default.fetch("https://preview.test/api/version");
    expect(version.headers.get("x-deployment-environment")).toBe("preview");
    await expect(version.json()).resolves.toMatchObject({ deploymentEnvironment: "preview" });
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
