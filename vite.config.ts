import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    plugins: [
      vinext(),
      cloudflare({
        // Static export and local Vite execution use the isolated preview
        // bindings, so production KV and required secrets are never loaded by
        // the build toolchain.
        configPath: "./wrangler.preview.jsonc",
        // Static export still needs Vinext's RSC handler while prerendering.
        // This build-only override does not change wrangler.jsonc: deploys use
        // the small API-only worker/index.ts entry instead.
        config: { main: "./worker/prerender.ts" },
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      }),
    ],
  };
});
