const CONNECTING_IP = /^[0-9A-Fa-f:.]{3,64}$/u;

export interface LightningRequestRateLimit {
  limit(options: Readonly<{ key: string }>): Promise<Readonly<{ success: boolean }>>;
}

export interface LightningRequestEnvironment {
  LIGHTNING_REQUEST_RATE_LIMITER?: LightningRequestRateLimit;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export type LightningRateLimitResult = "allowed" | "limited" | "unavailable";

export async function checkLightningRateLimit(
  request: Request,
  environment: LightningRequestEnvironment | undefined,
): Promise<LightningRateLimitResult> {
  const limiter = environment?.LIGHTNING_REQUEST_RATE_LIMITER;
  const connectingIp = request.headers.get("CF-Connecting-IP") ?? "";
  if (!limiter || !CONNECTING_IP.test(connectingIp)) return "unavailable";
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(connectingIp.toLowerCase()));
    const result = await limiter.limit({ key: `lightning:${base64Url(new Uint8Array(digest)).slice(0, 22)}` });
    if (!result || typeof result.success !== "boolean") return "unavailable";
    return result.success ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}
