import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getTradeRecordRetentionPolicy, TRADE_RECORD_SCHEMA_V1 } from "../app/lib/trade-record";
import {
  sha256Base64Url,
  managementKey,
  storageKey,
  storedManagedRecord,
} from "../worker/trade-record-lifecycle";
import { TradeRecordRequestError } from "../worker/trade-record-http";
import { StrongTradeRecordStorage } from "../worker/trade-record-state";
import { handleTradeRecordRequest, type TradeRecordKvNamespace } from "../worker/trade-record";

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
    expect(page.headers.get("x-deployment-environment")).toBe("production");
    expect(page.headers.has("x-robots-tag")).toBe(false);
    const html = await page.text();
    const notice = html.match(/<aside[^>]*id="deployment-environment-notice"[^>]*>/u)?.[0] ?? "";
    expect(notice).toContain("hidden");
    expect(html).not.toContain("data-deployment-environment=\"production\"");
    expect(html).not.toContain(">STAGING<");
    expect(html).not.toContain(">PREVIEW<");

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

  it("rejects corrupt legacy management tombstones before writing SQLite state", async () => {
    const tokenHash = await sha256Base64Url("HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH");
    const id = tokenHash.slice(0, 16);
    const tombstoneKey = managementKey(tokenHash);
    const stub = exports.TradeRecordState.get(exports.TradeRecordState.idFromName(id));
    const result = await runInDurableObject(stub, async (_instance, state) => {
      let legacyValue = "not-json";
      let legacyWrites = 0;
      const legacy: TradeRecordKvNamespace = {
        async get(key) {
          return key === tombstoneKey ? legacyValue : null;
        },
        async put() {
          legacyWrites += 1;
        },
        async delete() {
          legacyWrites += 1;
        },
      };
      const records = new StrongTradeRecordStorage(state, legacy);
      const failureCodes: string[] = [];
      for (const corruptValue of [
        "not-json",
        JSON.stringify({ version: 1, id: "AAAAAAAAAAAAAAAA", state: "revoked" }),
      ]) {
        legacyValue = corruptValue;
        try {
          await records.get(tombstoneKey);
        } catch (error) {
          if (!(error instanceof TradeRecordRequestError)) throw error;
          failureCodes.push(`${error.code}:${error.status}`);
        }
      }
      return {
        alarm: await state.storage.getAlarm(),
        failureCodes,
        legacyWrites,
        tables: state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'trade_record_entries'",
        ).toArray(),
      };
    });

    expect(result.failureCodes).toEqual(["STORAGE_CORRUPT:500", "STORAGE_CORRUPT:500"]);
    expect(result.legacyWrites).toBe(0);
    expect(result.tables).toEqual([]);
    expect(result.alarm).toBeNull();
  });

  it("serializes pending, finalize, public read, and revoke in the real SQLite Durable Object", async () => {
    const revokeToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const tokenHash = await sha256Base64Url(revokeToken);
    const id = tokenHash.slice(0, 16);
    const createdAtMs = Date.now();
    const retention = getTradeRecordRetentionPolicy(TRADE_RECORD_SCHEMA_V1).retentionSeconds;
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(createdAtMs + retention * 1_000).toISOString();
    const signed = {
      record: {
        schema: TRADE_RECORD_SCHEMA_V1,
        id,
        createdAt,
        expiresAt,
        condition: {
          role: "buyer" as const,
          amountBasis: "krw" as const,
          bitcoinDisplayUnit: "sats" as const,
          paymentKrw: 1_000_000,
          sats: 1_000_000,
          referencePriceKrw: 100_000_000,
          marketObservedAt: createdAt,
          koreaPremiumRatio: null,
          sellerPremiumBps: 0,
          fundingSource: null,
        },
        payment: null,
      },
      signature: "A".repeat(86),
      keyId: "production-runtime-test",
    };
    const stub = exports.TradeRecordState.get(exports.TradeRecordState.idFromName(id));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS trade_record_entries (
          entry_key TEXT PRIMARY KEY,
          entry_value TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL
        )
      `);
      state.storage.sql.exec(
        `INSERT INTO trade_record_entries (entry_key, entry_value, expires_at_ms)
         VALUES (?1, ?2, ?3)`,
        storageKey(id),
        JSON.stringify(storedManagedRecord(signed, "pending", tokenHash)),
        Date.parse(expiresAt),
      );
    });

    const publicRequest = () => new Request(`https://worker.test/api/trade-record/${id}`, {
      headers: { "CF-Connecting-IP": "203.0.113.104" },
    });
    expect((await exports.default.fetch(publicRequest())).status).toBe(404);

    const finalize = await exports.default.fetch(new Request(
      `https://worker.test/api/trade-record/${id}/finalize`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${revokeToken}`,
          "CF-Connecting-IP": "203.0.113.105",
        },
      },
    ));
    expect(finalize.status).toBe(200);
    await expect(finalize.json()).resolves.toMatchObject({ id, lifecycle: "finalized" });
    expect((await exports.default.fetch(publicRequest())).status).toBe(200);

    const revoke = await exports.default.fetch(new Request(
      `https://worker.test/api/trade-record/${id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${revokeToken}`,
          "CF-Connecting-IP": "203.0.113.106",
        },
      },
    ));
    expect(revoke.status).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({ id, lifecycle: "revoked" });
    expect((await exports.default.fetch(publicRequest())).status).toBe(404);
  });

  it("never re-exposes a record when finalize and revoke race in one Durable Object", async () => {
    const revokeToken = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const tokenHash = await sha256Base64Url(revokeToken);
    const id = tokenHash.slice(0, 16);
    const createdAtMs = Date.now();
    const retention = getTradeRecordRetentionPolicy(TRADE_RECORD_SCHEMA_V1).retentionSeconds;
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(createdAtMs + retention * 1_000).toISOString();
    const signed = {
      record: {
        schema: TRADE_RECORD_SCHEMA_V1,
        id,
        createdAt,
        expiresAt,
        condition: {
          role: "buyer" as const,
          amountBasis: "krw" as const,
          bitcoinDisplayUnit: "sats" as const,
          paymentKrw: 1_000_000,
          sats: 1_000_000,
          referencePriceKrw: 100_000_000,
          marketObservedAt: createdAt,
          koreaPremiumRatio: null,
          sellerPremiumBps: 0,
          fundingSource: null,
        },
        payment: null,
      },
      signature: "A".repeat(86),
      keyId: "production-runtime-race-test",
    };
    const stub = exports.TradeRecordState.get(exports.TradeRecordState.idFromName(id));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS trade_record_entries (
          entry_key TEXT PRIMARY KEY,
          entry_value TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL
        )
      `);
      state.storage.sql.exec(
        `INSERT INTO trade_record_entries (entry_key, entry_value, expires_at_ms)
         VALUES (?1, ?2, ?3)`,
        storageKey(id),
        JSON.stringify(storedManagedRecord(signed, "pending", tokenHash)),
        Date.parse(expiresAt),
      );
    });

    const finalizeRequest = new Request(`https://worker.test/api/trade-record/${id}/finalize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${revokeToken}`,
        "CF-Connecting-IP": "203.0.113.107",
      },
    });
    const revokeRequest = new Request(`https://worker.test/api/trade-record/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${revokeToken}`,
        "CF-Connecting-IP": "203.0.113.108",
      },
    });
    const [finalize, revoke] = await Promise.all([
      exports.default.fetch(finalizeRequest),
      exports.default.fetch(revokeRequest),
    ]);

    expect([200, 404]).toContain(finalize.status);
    expect(revoke.status).toBe(200);
    const afterRace = await exports.default.fetch(new Request(
      `https://worker.test/api/trade-record/${id}`,
      { headers: { "CF-Connecting-IP": "203.0.113.109" } },
    ));
    expect(afterRace.status).toBe(404);
    const rows = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM trade_record_entries WHERE entry_key = ?1",
      storageKey(id),
    ).toArray());
    expect(rows[0]?.count).toBe(0);
  });

  it("fails revoke closed during a legacy mirror outage and makes the idempotent retry rollback-safe", async () => {
    const revokeToken = "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG";
    const tokenHash = await sha256Base64Url(revokeToken);
    const id = tokenHash.slice(0, 16);
    const createdAtMs = Date.now();
    const retention = getTradeRecordRetentionPolicy(TRADE_RECORD_SCHEMA_V1).retentionSeconds;
    const createdAt = new Date(createdAtMs).toISOString();
    const signed = {
      record: {
        schema: TRADE_RECORD_SCHEMA_V1,
        id,
        createdAt,
        expiresAt: new Date(createdAtMs + retention * 1_000).toISOString(),
        condition: {
          role: "buyer" as const,
          amountBasis: "krw" as const,
          bitcoinDisplayUnit: "sats" as const,
          paymentKrw: 1_000_000,
          sats: 1_000_000,
          referencePriceKrw: 100_000_000,
          marketObservedAt: createdAt,
          koreaPremiumRatio: null,
          sellerPremiumBps: 0,
          fundingSource: null,
        },
        payment: null,
      },
      signature: "A".repeat(86),
      keyId: "production-runtime-legacy-mirror-test",
    };
    const recordKey = storageKey(id);
    const tombstoneKey = managementKey(tokenHash);
    const stub = exports.TradeRecordState.get(exports.TradeRecordState.idFromName(id));
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const legacyValues = new Map<string, string>([[
        recordKey,
        JSON.stringify(storedManagedRecord(signed, "finalized", tokenHash)),
      ]]);
      let outage = true;
      let deleteAttempts = 0;
      const legacy: TradeRecordKvNamespace = {
        async get(key) {
          return legacyValues.get(key) ?? null;
        },
        async put(key, value) {
          if (outage) throw new Error("simulated legacy KV outage");
          legacyValues.set(key, value);
        },
        async delete(key) {
          deleteAttempts += 1;
          if (outage) throw new Error("simulated legacy KV outage");
          legacyValues.delete(key);
        },
      };
      const records = new StrongTradeRecordStorage(state, legacy);
      const environment = {
        DEPLOYMENT_ENV: "production",
        TRADE_RECORDS_ENABLED: true,
        TRADE_RECORDS: records,
      };
      const request = () => new Request(`https://worker.test/api/trade-record/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${revokeToken}` },
      });

      const first = await handleTradeRecordRequest(request(), environment, { storageMode: "durable-object" });
      const firstBody = await first.json() as { code?: string };
      const exposedAfterFailure = legacyValues.has(recordKey);
      outage = false;
      const retried = await handleTradeRecordRequest(request(), environment, { storageMode: "durable-object" });

      return {
        deleteAttempts,
        exposedAfterFailure,
        firstCode: firstBody.code,
        firstRetryAfter: first.headers.get("retry-after"),
        firstStatus: first.status,
        legacyRecordExists: legacyValues.has(recordKey),
        legacyTombstone: legacyValues.get(tombstoneKey) ?? null,
        retryStatus: retried.status,
      };
    });

    expect(result.firstStatus).toBe(503);
    expect(result.firstCode).toBe("STORAGE_UNAVAILABLE");
    expect(result.firstRetryAfter).toBe("1");
    expect(result.exposedAfterFailure).toBe(true);
    expect(result.retryStatus).toBe(200);
    expect(result.deleteAttempts).toBe(2);
    expect(result.legacyRecordExists).toBe(false);
    expect(result.legacyTombstone).toBe(JSON.stringify({ version: 1, id, state: "revoked" }));
  });

  it("does not persist SQLite state for negative item requests", async () => {
    const negativeRequests = [
      {
        id: "AAAAAAAAAAAAAAAC",
        request: new Request("https://worker.test/api/trade-record/AAAAAAAAAAAAAAAC", {
          headers: { "CF-Connecting-IP": "203.0.113.110" },
        }),
      },
      ...await Promise.all([
        { token: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", method: "POST", suffix: "/finalize", ip: "203.0.113.111" },
        { token: "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE", method: "DELETE", suffix: "", ip: "203.0.113.112" },
      ].map(async ({ token, method, suffix, ip }) => {
        const id = (await sha256Base64Url(token)).slice(0, 16);
        return {
          id,
          request: new Request(`https://worker.test/api/trade-record/${id}${suffix}`, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              "CF-Connecting-IP": ip,
            },
          }),
        };
      })),
    ];

    for (const { id, request } of negativeRequests) {
      const response = await exports.default.fetch(request);
      expect(response.status).toBe(404);
      const stub = exports.TradeRecordState.get(exports.TradeRecordState.idFromName(id));
      const stateSnapshot = await runInDurableObject(stub, async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        tables: state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'trade_record_entries'",
        ).toArray(),
      }));
      expect(stateSnapshot.tables).toEqual([]);
      expect(stateSnapshot.alarm).toBeNull();
    }
  });

  it("deallocates empty expired state and recreates schema on a later legacy migration", async () => {
    const revokeToken = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
    const tokenHash = await sha256Base64Url(revokeToken);
    const id = tokenHash.slice(0, 16);
    const createdAtMs = Date.now();
    const retention = getTradeRecordRetentionPolicy(TRADE_RECORD_SCHEMA_V1).retentionSeconds;
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(createdAtMs + retention * 1_000).toISOString();
    const signed = {
      record: {
        schema: TRADE_RECORD_SCHEMA_V1,
        id,
        createdAt,
        expiresAt,
        condition: {
          role: "buyer" as const,
          amountBasis: "krw" as const,
          bitcoinDisplayUnit: "sats" as const,
          paymentKrw: 1_000_000,
          sats: 1_000_000,
          referencePriceKrw: 100_000_000,
          marketObservedAt: createdAt,
          koreaPremiumRatio: null,
          sellerPremiumBps: 0,
          fundingSource: null,
        },
        payment: null,
      },
      signature: "A".repeat(86),
      keyId: "production-runtime-expiry-test",
    };
    const stub = exports.TradeRecordState.get(exports.TradeRecordState.idFromName(id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS trade_record_entries (
          entry_key TEXT PRIMARY KEY,
          entry_value TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL
        )
      `);
      state.storage.sql.exec(
        `INSERT INTO trade_record_entries (entry_key, entry_value, expires_at_ms)
         VALUES (?1, ?2, ?3)`,
        storageKey(id),
        JSON.stringify(storedManagedRecord(signed, "finalized", tokenHash)),
        Date.now() - 1_000,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterExpiry = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      tables: state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'trade_record_entries'",
      ).toArray(),
    }));
    expect(afterExpiry.tables).toEqual([]);
    expect(afterExpiry.alarm).toBeNull();

    await env.TRADE_RECORDS.put(storageKey(id), JSON.stringify(signed), { expirationTtl: 60 });
    try {
      const migrated = await exports.default.fetch(new Request(
        `https://worker.test/api/trade-record/${id}`,
        { headers: { "CF-Connecting-IP": "203.0.113.113" } },
      ));
      expect(migrated.status).toBe(200);
      const afterMigration = await runInDurableObject(stub, async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        tables: state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'trade_record_entries'",
        ).toArray(),
      }));
      expect(afterMigration.tables).toEqual([{ name: "trade_record_entries" }]);
      expect(afterMigration.alarm).toBeTypeOf("number");
    } finally {
      await env.TRADE_RECORDS.delete(storageKey(id));
    }
  });

  it("rearms expired-state cleanup after a storage failure", async () => {
    const stub = exports.TradeRecordState.get(exports.TradeRecordState.idFromName("cleanup-rearm-test"));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TABLE trade_record_entries (
          entry_key TEXT PRIMARY KEY,
          entry_value TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL
        );
        CREATE TRIGGER fail_trade_record_cleanup
        BEFORE DELETE ON trade_record_entries
        BEGIN
          SELECT RAISE(ABORT, 'simulated cleanup failure');
        END;
        INSERT INTO trade_record_entries (entry_key, entry_value, expires_at_ms)
        VALUES ('expired', '{}', 0);
      `);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const cleanupStartedAt = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const failedCleanup = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      rows: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM trade_record_entries",
      ).one().count,
    }));
    expect(failedCleanup.rows).toBe(1);
    expect(failedCleanup.alarm).toBeGreaterThan(cleanupStartedAt);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_trade_record_cleanup");
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const recovered = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      tables: state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'trade_record_entries'",
      ).toArray(),
    }));
    expect(recovered.tables).toEqual([]);
    expect(recovered.alarm).toBeNull();
  });

  it("rethrows the cleanup error when the retry alarm cannot be persisted", async () => {
    const cleanupError = new Error("simulated cleanup failure");
    const retryAlarmError = new Error("simulated alarm failure");
    const scheduledTimes: number[] = [];
    const state = {
      storage: {
        setAlarm(scheduledTime: number | Date) {
          scheduledTimes.push(Number(scheduledTime));
          return Promise.reject(retryAlarmError);
        },
        sql: {
          exec(query: string) {
            if (query.includes("sqlite_schema")) {
              return { toArray: () => [{ name: "trade_record_entries" }] };
            }
            throw cleanupError;
          },
        },
      },
    } as unknown as DurableObjectState;
    const records = new StrongTradeRecordStorage(state);
    const cleanupStartedAt = Date.now();

    await expect(records.deleteExpired()).rejects.toBe(cleanupError);
    expect(scheduledTimes).toHaveLength(1);
    expect(scheduledTimes[0]).toBeGreaterThan(cleanupStartedAt);
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
    expect(response.headers.get("x-deployment-environment")).toBe("production");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      appVersion: "2.3.0",
      deploymentEnvironment: "production",
    });
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
        "Idempotency-Key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "X-Trade-Record-Lifecycle": "pending",
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

  it("enforces the real trade-record read limiter on the 121st lookup", async () => {
    const request = () => new Request(
      "https://worker.test/api/trade-record/AAAAAAAAAAAAAAAB",
      { headers: { "CF-Connecting-IP": "203.0.113.103" } },
    );

    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const response = await exports.default.fetch(request());
      expect(response.status, `trade-record lookup ${attempt}`).toBe(404);
    }

    const limited = await exports.default.fetch(request());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toMatchObject({ ok: false, code: "RATE_LIMITED" });
  }, 30_000);
});
