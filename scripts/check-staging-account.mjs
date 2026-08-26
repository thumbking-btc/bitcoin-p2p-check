import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_STAGING_ACCOUNT_ID = "dd961adc166c8b6e221e29b7867cb2a3";
export const EXPECTED_STAGING_WORKERS_DEV_SUBDOMAIN = "thumbking-btc";
export const MAX_STAGING_ACCOUNT_RESPONSE_BYTES = 16_384;

const IDENTITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,512}$/u;
const REQUEST_TIMEOUT_MS = 15_000;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateStagingAccountProbe(raw, requestedAccountId) {
  if (requestedAccountId !== EXPECTED_STAGING_ACCOUNT_ID) {
    throw new Error("staging Cloudflare account ID가 검토된 값과 다릅니다.");
  }
  if (typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > MAX_STAGING_ACCOUNT_RESPONSE_BYTES) {
    throw new Error("Cloudflare staging account 응답이 비어 있거나 허용 크기를 초과했습니다.");
  }

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error("Cloudflare staging account 응답이 유효한 JSON이 아닙니다.");
  }
  if (!isPlainObject(envelope)
    || envelope.success !== true
    || !Array.isArray(envelope.errors)
    || envelope.errors.length !== 0
    || !isPlainObject(envelope.result)
    || envelope.result.subdomain !== EXPECTED_STAGING_WORKERS_DEV_SUBDOMAIN) {
    throw new Error("Cloudflare staging account 또는 workers.dev subdomain이 검토된 값과 다릅니다.");
  }
  return Object.freeze({
    accountId: EXPECTED_STAGING_ACCOUNT_ID,
    workersDevSubdomain: EXPECTED_STAGING_WORKERS_DEV_SUBDOMAIN,
  });
}

async function readBoundedBody(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      throw new Error("Cloudflare staging account 응답 길이를 확인하지 못했습니다.");
    }
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)
      || declaredLength > MAX_STAGING_ACCOUNT_RESPONSE_BYTES) {
      throw new Error("Cloudflare staging account 응답이 허용 크기를 초과했습니다.");
    }
  }
  if (!response.body) throw new Error("Cloudflare staging account 응답 본문이 없습니다.");

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_STAGING_ACCOUNT_RESPONSE_BYTES) {
        void reader.cancel("response too large").catch(() => undefined);
        throw new Error("Cloudflare staging account 응답이 허용 크기를 초과했습니다.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("Cloudflare staging account 응답 문자 형식을 확인하지 못했습니다.");
  }
}

export async function verifyStagingAccountIdentity({ fetcher = globalThis.fetch } = {}) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const identityToken = process.env.CLOUDFLARE_STAGING_IDENTITY_TOKEN ?? "";
  if (accountId !== EXPECTED_STAGING_ACCOUNT_ID
    || !IDENTITY_TOKEN_PATTERN.test(identityToken)
    || typeof fetcher !== "function") {
    throw new Error("검토된 staging account와 account-scoped read-only identity credential이 필요합니다.");
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${EXPECTED_STAGING_ACCOUNT_ID}/workers/subdomain`;
  let response;
  try {
    response = await fetcher(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${identityToken}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Cloudflare staging account identity 조회에 실패했습니다.");
  }
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (response.status !== 200 || mediaType !== "application/json") {
    if (response.body) void response.body.cancel("unexpected response").catch(() => undefined);
    throw new Error("Cloudflare staging account identity 응답을 확인하지 못했습니다.");
  }
  return validateStagingAccountProbe(await readBoundedBody(response), accountId);
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("사용법: check-staging-account.mjs");
  }
  const identity = await verifyStagingAccountIdentity();
  console.log(
    `격리 staging account ${identity.accountId}와 workers.dev subdomain ${identity.workersDevSubdomain}를 확인했습니다.`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
