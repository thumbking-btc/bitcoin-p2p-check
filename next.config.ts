import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vinext uses Next's export mode to prerender each App Router page into
  // dist/client. Cloudflare can then serve HTML without starting the Worker.
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
