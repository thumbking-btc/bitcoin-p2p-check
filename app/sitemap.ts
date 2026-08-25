import type { MetadataRoute } from "next";

const ORIGIN = "https://bitcoin-p2p-check.thumbking-btc.workers.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${ORIGIN}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${ORIGIN}/install/`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${ORIGIN}/privacy/`, changeFrequency: "monthly", priority: 0.4 },
  ];
}
