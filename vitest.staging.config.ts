import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.staging.jsonc" },
      miniflare: {
        // Binding presence and routing are tested here; signing behavior uses
        // generated keys in the Node integration suite.
        bindings: { TRADE_RECORD_SIGNING_KEY: "test-only-not-a-signing-key" },
      },
    }),
  ],
  test: {
    include: ["worker-tests/staging.runtime.test.ts"],
    testTimeout: 15_000,
  },
});
