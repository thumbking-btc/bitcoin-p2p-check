export const PRODUCTION_HOSTNAME = "bitcoin-p2p-check.thumbking-btc.workers.dev";
export const STAGING_HOSTNAME = "bitcoin-p2p-check-staging.thumbking-btc.workers.dev";
export const LEGACY_STAGING_ALIAS_HOSTNAME = "staging-bitcoin-p2p-check.thumbking-btc.workers.dev";
export const PREVIEW_HOSTNAME = "bitcoin-p2p-check-preview.thumbking-btc.workers.dev";

const KNOWN_ENVIRONMENTS = new Set(["production", "staging", "preview"]);

/**
 * @param {unknown} value
 * @returns {"production" | "staging" | "preview" | "unknown"}
 */
export function normalizeDeploymentEnvironment(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  return KNOWN_ENVIRONMENTS.has(normalized) ? normalized : "unknown";
}

/**
 * Preserves the distinction between a missing environment report and an
 * explicit fail-closed `unknown` report.
 *
 * @param {unknown} value
 * @returns {"production" | "staging" | "preview" | "unknown" | null}
 */
export function normalizeOptionalDeploymentEnvironment(value) {
  return value === null || value === undefined
    ? null
    : normalizeDeploymentEnvironment(value);
}

/**
 * Hostname inference is a fallback for a failed version request. The Worker-reported
 * environment remains authoritative when it is available.
 *
 * @param {unknown} value
 * @returns {"production" | "staging" | "preview" | "unknown"}
 */
export function inferDeploymentEnvironment(value) {
  if (typeof value !== "string") return "unknown";
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  if (hostname === PRODUCTION_HOSTNAME) return "production";
  if (hostname === STAGING_HOSTNAME || hostname === LEGACY_STAGING_ALIAS_HOSTNAME) return "staging";
  if (hostname === PREVIEW_HOSTNAME) return "preview";
  if (hostname.endsWith(`-${STAGING_HOSTNAME}`)) return "staging";
  if (hostname.endsWith(`-${PREVIEW_HOSTNAME}`)) return "preview";
  if (hostname.endsWith(`-${PRODUCTION_HOSTNAME}`)) return "preview";
  return "unknown";
}

/**
 * Preview PWA review is an explicit, origin-local exception used only for an
 * exact Cloudflare commit preview or the isolated canonical staging. A review
 * host must also carry the matching Worker environment annotation before
 * registration is allowed.
 *
 * @param {unknown} hostname
 * @param {unknown} annotatedEnvironment
 * @param {unknown} pwaReviewOptIn
 */
export function shouldDisableServiceWorker(hostname, annotatedEnvironment, pwaReviewOptIn = false) {
  const annotated = normalizeOptionalDeploymentEnvironment(annotatedEnvironment);
  const environment = inferDeploymentEnvironment(hostname);
  if (pwaReviewOptIn === true && annotated === "staging" && hostname === STAGING_HOSTNAME) {
    return false;
  }
  if (pwaReviewOptIn === true && annotated === "preview" && environment === "preview") {
    return false;
  }
  if (annotated !== null && annotated !== "production") {
    return true;
  }
  return environment === "staging" || environment === "preview";
}

/**
 * @param {unknown} reportedEnvironment
 * @param {unknown} hostname
 */
export function resolveDeploymentNotice(reportedEnvironment, hostname) {
  const reported = normalizeOptionalDeploymentEnvironment(reportedEnvironment);
  const inferred = inferDeploymentEnvironment(hostname);
  const effective = reported ?? inferred;
  const mismatch = reported !== null
    && reported !== "unknown"
    && inferred !== "unknown"
    && reported !== inferred;

  if (effective === "production" && !mismatch) return null;
  if (reported === null && effective === "unknown" && !mismatch) return null;

  return Object.freeze({
    environment: effective,
    mismatch,
    inferredEnvironment: inferred,
    reportedEnvironment: reported ?? "unknown",
  });
}
