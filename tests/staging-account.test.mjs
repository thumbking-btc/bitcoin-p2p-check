import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXPECTED_STAGING_ACCOUNT_ID,
  EXPECTED_STAGING_WORKERS_DEV_SUBDOMAIN,
  MAX_STAGING_ACCOUNT_RESPONSE_BYTES,
  validateStagingAccountProbe,
  verifyStagingAccountIdentity,
} from "../scripts/check-staging-account.mjs";

function responseBody(subdomain = EXPECTED_STAGING_WORKERS_DEV_SUBDOMAIN) {
  return JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: { subdomain },
  });
}

test("accepts only the reviewed staging account and workers.dev subdomain", () => {
  assert.deepEqual(
    validateStagingAccountProbe(responseBody(), EXPECTED_STAGING_ACCOUNT_ID),
    {
      accountId: EXPECTED_STAGING_ACCOUNT_ID,
      workersDevSubdomain: EXPECTED_STAGING_WORKERS_DEV_SUBDOMAIN,
    },
  );
  assert.throws(
    () => validateStagingAccountProbe(responseBody(), "00000000000000000000000000000000"),
    /account ID/u,
  );
  assert.throws(
    () => validateStagingAccountProbe(responseBody("wrong-account"), EXPECTED_STAGING_ACCOUNT_ID),
    /subdomain/u,
  );
  assert.throws(
    () => validateStagingAccountProbe(JSON.stringify({
      success: false,
      errors: [{ code: 10000, message: "denied" }],
      result: { subdomain: EXPECTED_STAGING_WORKERS_DEV_SUBDOMAIN },
    }), EXPECTED_STAGING_ACCOUNT_ID),
    /subdomain/u,
  );
  assert.throws(
    () => validateStagingAccountProbe("{".padEnd(MAX_STAGING_ACCOUNT_RESPONSE_BYTES + 1, " "), EXPECTED_STAGING_ACCOUNT_ID),
    /허용 크기/u,
  );
});

test("uses a separate read-only identity credential against the exact account endpoint", async () => {
  const previousAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const previousIdentityToken = process.env.CLOUDFLARE_STAGING_IDENTITY_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = EXPECTED_STAGING_ACCOUNT_ID;
  process.env.CLOUDFLARE_STAGING_IDENTITY_TOKEN = "a".repeat(40);
  try {
    const identity = await verifyStagingAccountIdentity({
      fetcher: async (input, init) => {
        assert.equal(
          input,
          `https://api.cloudflare.com/client/v4/accounts/${EXPECTED_STAGING_ACCOUNT_ID}/workers/subdomain`,
        );
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "error");
        assert.equal(init.headers.Authorization, `Bearer ${"a".repeat(40)}`);
        assert.equal(init.signal instanceof AbortSignal, true);
        return new Response(responseBody(), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    assert.equal(identity.accountId, EXPECTED_STAGING_ACCOUNT_ID);
  } finally {
    if (previousAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccountId;
    if (previousIdentityToken === undefined) delete process.env.CLOUDFLARE_STAGING_IDENTITY_TOKEN;
    else process.env.CLOUDFLARE_STAGING_IDENTITY_TOKEN = previousIdentityToken;
  }
});

test("bootstrap artifact validation rechecks account identity immediately before mutation", async () => {
  const [artifactGuard, operations] = await Promise.all([
    readFile(new URL("../scripts/check-staging-artifact.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/production-operations.md", import.meta.url), "utf8"),
  ]);
  assert.match(artifactGuard, /import \{ verifyStagingAccountIdentity \}/u);
  assert.match(artifactGuard, /await verifyStagingAccountIdentity\(\)/u);
  assert.match(operations, /CLOUDFLARE_STAGING_IDENTITY_TOKEN/u);
  assert.match(operations, /node scripts\/check-staging-account\.mjs/u);
  assert.match(operations, /Workers Scripts Read/u);
});
