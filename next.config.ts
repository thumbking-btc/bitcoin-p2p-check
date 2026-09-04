import type { NextConfig } from "next";
import { readBuildIdentity } from "./scripts/build-identity.mjs";

const buildIdentity = readBuildIdentity();
const nextConfig: NextConfig = {
  // Vinext otherwise embeds a new random RSC compatibility ID into every build.
  // Bind both identities to the exact source checkout, not the build machine.
  deploymentId: buildIdentity,
  generateBuildId: () => buildIdentity,
  // Export HTML into dist/client; the secured static Worker serves it at runtime.
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
