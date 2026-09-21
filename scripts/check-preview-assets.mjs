#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ASSETS = 128;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function validatePreviewOrigin(value) {
  assert.match(value, /^https:\/\/[0-9a-f]{8}-bitcoin-p2p-check\.thumbking-btc\.workers\.dev$/u);
  return value;
}

export function assertAssetIdentity(assetPath, expected, actual) {
  assert.equal(actual.status, 200, `${assetPath}: asset is missing`);
  assert.equal(actual.headers.get("x-content-type-options"), "nosniff", `${assetPath}: missing nosniff`);
  const mime = actual.headers.get("content-type")?.split(";", 1)[0].trim();
  if (assetPath.endsWith(".css")) assert.equal(mime, "text/css", `${assetPath}: wrong CSS media type`);
  if (assetPath.endsWith(".js")) assert.ok(["text/javascript", "application/javascript"].includes(mime), `${assetPath}: wrong JavaScript media type`);
  assert.equal(actual.body.equals(expected), true, `${assetPath}: deployed bytes differ from the verified build`);
  if (assetPath.startsWith("/_next/static/")) {
    const directives = (actual.headers.get("cache-control") ?? "").split(",").map((value) => value.trim().toLowerCase());
    for (const directive of ["public", "max-age=31536000", "immutable"]) assert.ok(directives.includes(directive), `${assetPath}: weak fingerprint cache policy`);
  }
  return { path: assetPath, bytes: expected.length, sha256: digest(expected) };
}

async function readRemote(baseUrl, relativePath) {
  const url = new URL(relativePath, baseUrl);
  assert.equal(url.origin, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let reader;
  try {
    const response = await fetch(url, {
      method: "GET", redirect: "error", cache: "no-store", credentials: "omit", signal: controller.signal,
    });
    assert.ok(Number(response.headers.get("content-length") ?? "0") <= MAX_BYTES, "Oversized response");
    reader = response.body?.getReader();
    const chunks = [];
    let length = 0;
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        assert.ok(length <= MAX_BYTES, "Oversized streamed response");
        chunks.push(value);
      }
    }
    return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
  }
}

async function collectBundles(directory, prefix = "/_next/static") {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!item.isSymbolicLink(), "Static assets must not follow symlinks");
    if (item.isDirectory()) files.push(...await collectBundles(path.join(directory, item.name), `${prefix}/${item.name}`));
    else if (item.isFile() && /\.(?:js|css)$/u.test(item.name)) files.push(`${prefix}/${item.name}`);
  }
  assert.ok(files.length <= MAX_ASSETS, "Unexpected static bundle count");
  return files.sort();
}

export async function checkPreviewAssets(baseUrl, root = ROOT) {
  validatePreviewOrigin(baseUrl);
  const client = path.join(root, "dist/client");
  const report = { baseUrl, routes: [], assets: [] };
  const readVersion = async () => {
    const result = await readRemote(baseUrl, "/api/version");
    assert.equal(result.status, 200);
    const version = JSON.parse(result.body.toString("utf8"));
    assert.equal(version.ok, true);
    assert.equal(version.deploymentEnvironment, "preview");
    assert.equal(result.headers.get("x-deployment-environment"), "preview");
    assert.equal(version.workerVersion?.id?.slice(0, 8), new URL(baseUrl).hostname.slice(0, 8));
    return version;
  };
  const version = await readVersion();
  report.version = version;
  const policy = (await readFile(path.join(client, "csp-policy.txt"), "utf8")).trim();
  for (const route of ["/", "/?pwa-review=1", "/install/", "/privacy/", "/verify/"]) {
    const result = await readRemote(baseUrl, route);
    assert.equal(result.status, 200, `${route}: missing HTML`);
    assert.match(result.headers.get("content-type") ?? "", /^text\/html(?:;|$)/u);
    assert.equal(result.headers.get("content-security-policy"), policy, `${route}: CSP is not from the verified build`);
    assert.equal(result.headers.get("x-deployment-environment"), "preview");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.match(result.headers.get("cache-control") ?? "", /(?:^|,)\s*no-store\s*(?:,|$)/u);
    assert.match(result.body.toString("utf8"), /<html\b[^>]*data-deployment-environment="preview"/u);
    report.routes.push(route);
  }
  const bundles = await collectBundles(path.join(client, "_next/static"));
  assert.ok(bundles.some((value) => value.endsWith(".css")) && bundles.some((value) => value.endsWith(".js")));
  for (const assetPath of [...bundles, "/sw.js", "/manifest.webmanifest", "/csp-policy.txt"]) {
    const expected = await readFile(path.join(client, assetPath.slice(1)));
    const actual = await readRemote(baseUrl, assetPath);
    report.assets.push(assertAssetIdentity(assetPath, expected, actual));
    if (assetPath === "/sw.js") {
      assert.equal(actual.headers.get("service-worker-allowed"), "/");
      assert.match(actual.headers.get("cache-control") ?? "", /no-store/u);
    }
  }
  assert.deepEqual(await readVersion(), version, "The deployment changed during verification");
  await mkdir(path.join(root, "render-diagnostics"), { recursive: true });
  await writeFile(path.join(root, "render-diagnostics/asset-identity.json"), JSON.stringify(report, null, 2));
  console.log(`PASS exact deployed asset bytes: ${report.assets.length} files; enforced CSP: ${report.routes.length} routes; version ${version.workerVersion.id}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkPreviewAssets(process.env.PREVIEW_BASE_URL ?? "").catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
