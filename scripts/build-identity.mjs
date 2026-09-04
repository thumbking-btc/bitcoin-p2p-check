import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** @param {unknown} value */
export function validateBuildCommit(value) {
  const commit = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("A full source commit is required for a reproducible build");
  return commit;
}

// Build-only identity, never a runtime credential. Do not use GITHUB_SHA here:
// pull-request events can advertise a synthetic merge rather than the checkout.
export function readBuildIdentity() {
  return validateBuildCommit(execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8",
    timeout: 5000, maxBuffer: 4096,
  }));
}
