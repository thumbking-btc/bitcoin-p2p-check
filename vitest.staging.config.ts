import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.staging.jsonc" },
    }),
  ],
  test: {
    include: ["worker-tests/staging.runtime.test.ts"],
    testTimeout: 15_000,
  },
});
