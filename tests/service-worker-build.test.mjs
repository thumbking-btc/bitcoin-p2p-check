import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readBuildIdentity } from "../scripts/build-identity.mjs";

test("built service worker changes its script and cache namespace with the source commit", async () => {
  const worker = await readFile(new URL("../dist/client/sw.js", import.meta.url), "utf8");
  assert.ok(worker.includes(`const BUILD_ID = "${readBuildIdentity()}";`));
  assert.ok(worker.includes('${BUILD_ID}'));
  assert.ok(!worker.includes('const BUILD_ID = "development";'));
});
