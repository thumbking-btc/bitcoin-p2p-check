import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateBuildCommit } from "../scripts/build-identity.mjs";

test("build identity requires a complete source commit, never a random or ambiguous fallback", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(validateBuildCommit(sha + "\n"), sha);
  for (const value of [null, "", "main", "01234567", "0793c305-178e-4333-8bde-b27f3d1c7ace", sha + "0", sha.toUpperCase()]) {
    assert.throws(() => validateBuildCommit(value));
  }
});

test("the bundle and RSC compatibility ID use the same source identity", async () => {
  const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /const buildIdentity = readBuildIdentity\(\)/u);
  assert.match(config, /deploymentId: buildIdentity/u);
  assert.match(config, /generateBuildId: \(\) => buildIdentity/u);
  assert.doesNotMatch(config, /randomUUID|Date\.now|Math\.random/u);
});
