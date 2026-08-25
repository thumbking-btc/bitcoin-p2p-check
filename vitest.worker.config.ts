import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Integration tests never sign a record, but the production config
        // intentionally declares this secret as required.
        bindings: { TRADE_RECORD_SIGNING_KEY: "test-only-not-a-signing-key" },
      },
    }),
  ],
  test: {
    include: ["worker-tests/production.runtime.test.ts"],
    testTimeout: 15_000,
  },
});
