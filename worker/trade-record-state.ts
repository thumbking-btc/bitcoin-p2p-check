import { DurableObject } from "cloudflare:workers";
import { getTradeRecordRetentionPolicy, TRADE_RECORD_SCHEMA_V1 } from "../app/lib/trade-record.ts";
import {
  PENDING_RECORD_TTL_SECONDS,
  parseStoredRecord,
} from "./trade-record-lifecycle.ts";
import {
  handleTradeRecordRequest,
  type TradeRecordKvNamespace,
} from "./trade-record.ts";

const STORAGE_KEY_PREFIX = "trade-record:v1:";
const MANAGEMENT_KEY_PREFIX = "trade-record:v1:manage:";
const STORAGE_TABLE_NAME = "trade_record_entries";
const MAX_ENTRY_BYTES = 8_192;

type StoredRow = Readonly<{
  entry_key: string;
  entry_value: string;
  expires_at_ms: number;
}>;

function remainingTtlSeconds(expiresAtMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
}

function legacyEntryTtlSeconds(key: string, value: string, nowMs = Date.now()): number {
  if (key.startsWith(MANAGEMENT_KEY_PREFIX)) {
    return getTradeRecordRetentionPolicy(TRADE_RECORD_SCHEMA_V1).retentionSeconds;
  }
  if (!key.startsWith(STORAGE_KEY_PREFIX)) return 0;
  const parsed = parseStoredRecord(value);
  const expiresAtMs = parsed.lifecycle === "pending"
    ? Date.parse(parsed.signed.record.createdAt) + PENDING_RECORD_TTL_SECONDS * 1_000
    : Date.parse(parsed.signed.record.expiresAt);
  return remainingTtlSeconds(expiresAtMs, nowMs);
}

export class StrongTradeRecordStorage implements TradeRecordKvNamespace {
  private legacyMirror: Promise<void> = Promise.resolve();
  private legacyMirrorFailed = false;
  private legacyMirrorFailure: unknown;
  private schemaReady: boolean | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly legacy?: TradeRecordKvNamespace,
  ) {}

  private hasSchema(): boolean {
    if (this.schemaReady !== null) return this.schemaReady;
    const rows = this.state.storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?1 LIMIT 1",
      STORAGE_TABLE_NAME,
    ).toArray();
    this.schemaReady = rows.length === 1;
    return this.schemaReady;
  }

  private ensureSchema(): void {
    if (this.hasSchema()) return;
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS trade_record_entries (
        entry_key TEXT PRIMARY KEY,
        entry_value TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      )
    `);
    this.schemaReady = true;
  }

  private row(key: string): StoredRow | null {
    if (!this.hasSchema()) return null;
    const rows = this.state.storage.sql.exec<StoredRow>(
      "SELECT entry_key, entry_value, expires_at_ms FROM trade_record_entries WHERE entry_key = ?1 LIMIT 1",
      key,
    ).toArray();
    return rows[0] ?? null;
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (!this.hasSchema()) return;
    const rows = this.state.storage.sql.exec<{ next_expiry: number | null }>(
      "SELECT MIN(expires_at_ms) AS next_expiry FROM trade_record_entries",
    ).toArray();
    const nextExpiry = rows[0]?.next_expiry;
    if (typeof nextExpiry === "number" && Number.isFinite(nextExpiry)) {
      await this.state.storage.setAlarm(Math.max(Date.now() + 1_000, nextExpiry));
    } else {
      await this.state.storage.deleteAll();
      this.schemaReady = false;
    }
  }

  async get(key: string): Promise<string | null> {
    const nowMs = Date.now();
    const row = this.row(key);
    if (row && row.expires_at_ms > nowMs) return row.entry_value;
    if (row) {
      this.state.storage.sql.exec("DELETE FROM trade_record_entries WHERE entry_key = ?1", key);
      await this.scheduleNextAlarm();
    }

    const legacyValue = await this.legacy?.get(key) ?? null;
    if (legacyValue === null) return null;
    const ttl = legacyEntryTtlSeconds(key, legacyValue, nowMs);
    if (ttl <= 0) return null;
    await this.putLocal(key, legacyValue, ttl);
    return legacyValue;
  }

  private async putLocal(key: string, value: string, expirationTtl: number): Promise<void> {
    if (!Number.isInteger(expirationTtl) || expirationTtl <= 0) {
      throw new RangeError("Trade-record storage TTL must be a positive integer.");
    }
    if (new TextEncoder().encode(value).byteLength > MAX_ENTRY_BYTES) {
      throw new RangeError("Trade-record storage entry is too large.");
    }
    this.ensureSchema();
    const expiresAtMs = Date.now() + expirationTtl * 1_000;
    this.state.storage.sql.exec(
      `INSERT INTO trade_record_entries (entry_key, entry_value, expires_at_ms)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(entry_key) DO UPDATE SET entry_value = excluded.entry_value, expires_at_ms = excluded.expires_at_ms`,
      key,
      value,
      expiresAtMs,
    );
    await this.scheduleNextAlarm();
  }

  private mirrorToLegacy(operation: () => Promise<void>): void {
    this.legacyMirror = this.legacyMirror
      .then(operation)
      .catch((error: unknown) => {
        if (!this.legacyMirrorFailed) this.legacyMirrorFailure = error;
        this.legacyMirrorFailed = true;
      });
    this.state.waitUntil(this.legacyMirror);
  }

  async flushLegacyMirror(): Promise<void> {
    // Every queued operation settles before the tail does. Capture the batch's
    // first failure, then reset it so a later idempotent revocation can retry
    // the tombstone and deletion instead of inheriting a stale failure.
    await this.legacyMirror;
    const failed = this.legacyMirrorFailed;
    const failure = this.legacyMirrorFailure;
    this.legacyMirrorFailed = false;
    this.legacyMirrorFailure = undefined;
    if (failed) throw failure;
  }

  async put(key: string, value: string, options: Readonly<{ expirationTtl: number }>): Promise<void> {
    await this.putLocal(key, value, options.expirationTtl);
    if (this.legacy) {
      this.mirrorToLegacy(() => this.legacy!.put(key, value, options));
    }
  }

  async delete(key: string): Promise<void> {
    if (this.hasSchema()) {
      this.state.storage.sql.exec("DELETE FROM trade_record_entries WHERE entry_key = ?1", key);
      await this.scheduleNextAlarm();
    }
    if (this.legacy) {
      this.mirrorToLegacy(() => this.legacy!.delete(key));
    }
  }

  async deleteExpired(): Promise<void> {
    if (!this.hasSchema()) return;
    this.state.storage.sql.exec("DELETE FROM trade_record_entries WHERE expires_at_ms <= ?1", Date.now());
    await this.scheduleNextAlarm();
  }
}

/**
 * One SQLite-backed Durable Object is selected per record ID. The serialized
 * request queue keeps create/finalize/revoke and public reads linearizable even
 * while the handler awaits external market verification or legacy KV reads.
 */
export class TradeRecordState extends DurableObject<Env> {
  private readonly records: StrongTradeRecordStorage;
  private operation: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, environment: Env) {
    super(state, environment);
    this.records = new StrongTradeRecordStorage(
      state,
      environment.TRADE_RECORDS as unknown as TradeRecordKvNamespace | undefined,
    );
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  fetch(request: Request): Promise<Response> {
    return this.serialize(() => handleTradeRecordRequest(
      request,
      {
        DEPLOYMENT_ENV: this.env.DEPLOYMENT_ENV,
        TRADE_RECORDS_ENABLED: this.env.TRADE_RECORDS_ENABLED,
        TRADE_RECORDS: this.records,
        TRADE_RECORD_CREATE_RATE_LIMITER: this.env.TRADE_RECORD_CREATE_RATE_LIMITER,
        TRADE_RECORD_READ_RATE_LIMITER: this.env.TRADE_RECORD_READ_RATE_LIMITER,
        TRADE_RECORD_SIGNING_KEY: this.env.TRADE_RECORD_SIGNING_KEY,
      },
      { storageMode: "durable-object" },
    ));
  }

  alarm(): Promise<void> {
    return this.serialize(() => this.records.deleteExpired());
  }
}
