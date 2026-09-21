import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/install/"],
      disallow: ["/verify/", "/api/"],
    },
    sitemap: "https://bitcoin-p2p-check.thumbking-btc.workers.dev/sitemap.xml",
  };
}
