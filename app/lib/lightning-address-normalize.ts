const LIGHTNING_ADDRESS_MAX_LENGTH = 320;
const LIGHTNING_USERNAME = /^[a-z0-9._+-]{1,128}$/u;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ASCII_DOMAIN = /^[A-Za-z0-9.-]+$/u;
const RESERVED_SUFFIXES = ["localhost", "local", "internal", "invalid", "test", "example"] as const;

export type NormalizedLightningAddress = Readonly<{
  address: string;
  domain: string;
  username: string;
}>;

export class LightningAddressNormalizationError extends TypeError {
  constructor() {
    super("invalid lightning address");
    this.name = "LightningAddressNormalizationError";
  }
}

export function isPublicHostnameSyntax(value: string): boolean {
  const hostname = value.toLowerCase();
  if (
    !hostname
    || hostname.length > 253
    || !ASCII_DOMAIN.test(value)
    || hostname.endsWith(".")
    || hostname.includes("..")
    || hostname.includes(":")
    || /^\d+(?:\.\d+){3}$/u.test(hostname)
    || RESERVED_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
  ) {
    return false;
  }
  const labels = hostname.split(".");
  return labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label));
}

export function normalizeLightningAddress(value: unknown): NormalizedLightningAddress {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > LIGHTNING_ADDRESS_MAX_LENGTH
    || value !== value.trim()
    || /[^\x21-\x7e]/u.test(value)
  ) {
    throw new LightningAddressNormalizationError();
  }
  const separator = value.indexOf("@");
  if (separator <= 0 || separator !== value.lastIndexOf("@") || separator === value.length - 1) {
    throw new LightningAddressNormalizationError();
  }
  const username = value.slice(0, separator).toLowerCase();
  const domain = value.slice(separator + 1).toLowerCase();
  if (!LIGHTNING_USERNAME.test(username) || !isPublicHostnameSyntax(domain)) {
    throw new LightningAddressNormalizationError();
  }
  return Object.freeze({ address: `${username}@${domain}`, domain, username });
}

export function safePublicHttpsUrl(input: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input, base);
  } catch {
    throw new LightningAddressNormalizationError();
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || (url.port !== "" && url.port !== "443")
    || !isPublicHostnameSyntax(hostname)
  ) {
    throw new LightningAddressNormalizationError();
  }
  url.hostname = hostname;
  url.hash = "";
  return url;
}

/**
 * This is a hostname-syntax boundary only. Workers fetch still resolves DNS and
 * follows Cloudflare network policy; this helper does not claim DNS-rebinding protection.
 */
export function isSameOrSubdomain(candidate: string, anchor: string): boolean {
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedAnchor = anchor.toLowerCase();
  return normalizedCandidate === normalizedAnchor || normalizedCandidate.endsWith(`.${normalizedAnchor}`);
}
