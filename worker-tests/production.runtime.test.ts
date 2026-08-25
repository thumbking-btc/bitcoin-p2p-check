import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("production Worker bindings and routing", () => {
  it("applies Worker-owned CSP and static security headers, including the service-worker cache policy", async () => {
    const page = await exports.default.fetch("https://worker.test/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html\b/u);
    expect(page.headers.get("content-security-policy")).toMatch(/\bscript-src\b[^;]*'sha256-/u);
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(page.headers.get("origin-agent-cluster")).toBe("?1");
    expect(page.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(page.headers.get("permissions-policy")).toContain("camera=()");

    const serviceWorker = await exports.default.fetch("https://worker.test/sw.js");
    expect(serviceWorker.status).toBe(200);
    expect(serviceWorker.headers.get("content-type")).toMatch(/^text\/javascript\b/u);
    expect(serviceWorker.headers.get("cache-control")).toContain("no-store");
    expect(serviceWorker.headers.get("service-worker-allowed")).toBe("/");
  });

  it("uses an isolated local KV binding inside workerd", async () => {
    const key = "runtime-test:binding";
    await env.TRADE_RECORDS.put(key, "ok", { expirationTtl: 60 });
    expect(await env.TRADE_RECORDS.get(key)).toBe("ok");
    await env.TRADE_RECORDS.delete(key);
    expect(await env.TRADE_RECORDS.get(key)).toBeNull();
  });

  it("returns a secure JSON 404 for every unknown API route", async () => {
    const response = await exports.default.fetch("https://worker.test/api/unknown");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/^application\/json\b/u);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("exposes non-secret release metadata without caching it", async () => {
    const response = await exports.default.fetch("https://worker.test/api/version");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ ok: true, appVersion: "2.3.0" });
  });

  it("rejects a forged JSON media type through the real Lightning limiter binding", async () => {
    const response = await exports.default.fetch(new Request(
      "https://worker.test/api/market?receive=lightning-address",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.45",
          "Content-Type": "text/plain; foo=application/json",
        },
        body: JSON.stringify({ address: "alice@example.com", amountSats: 10_000 }),
      },
    ));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("enforces the real Lightning limiter binding on the thirteenth request", async () => {
    const request = () => new Request(
      "https://worker.test/api/market?receive=lightning-address",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.101",
          "Content-Type": "text/plain; foo=application/json",
        },
        body: JSON.stringify({ address: "alice@example.com", amountSats: 10_000 }),
      },
    );

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const response = await exports.default.fetch(request());
      expect(response.status, `Lightning request ${attempt}`).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    }

    const limited = await exports.default.fetch(request());
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ ok: false, code: "RATE_LIMITED" });
  });

  it("enforces the real trade-record limiter binding on the seventh create request", async () => {
    const request = () => new Request("https://worker.test/api/trade-record", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.102",
        "Content-Type": "text/plain; foo=application/json",
      },
      body: "{}",
    });

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await exports.default.fetch(request());
      expect(response.status, `trade-record request ${attempt}`).toBe(415);
      await expect(response.json()).resolves.toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    }

    const limited = await exports.default.fetch(request());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toMatchObject({ ok: false, code: "RATE_LIMITED" });
  });
});
