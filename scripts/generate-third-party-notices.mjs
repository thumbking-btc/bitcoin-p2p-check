import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputPath = path.join(projectRoot, "THIRD_PARTY_NOTICES.md");
const lock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
const rootManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

const runtimePackages = [];
for (const [packageKey, lockEntry] of Object.entries(lock.packages ?? {})) {
  if (!packageKey.startsWith("node_modules/") || lockEntry.dev === true) continue;
  const packageDirectory = path.join(projectRoot, ...packageKey.split("/"));
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
  const candidates = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING", "NOTICE", "CopyrightNotice.txt"];
  const licenseFiles = [];
  for (const filename of candidates) {
    try {
      licenseFiles.push({ filename, text: await readFile(path.join(packageDirectory, filename), "utf8") });
    } catch (reason) {
      if (reason?.code !== "ENOENT") throw reason;
    }
  }
  if (licenseFiles.length === 0) {
    throw new Error(`${manifest.name}@${manifest.version} has no packaged license or notice file`);
  }
  const repository = typeof manifest.repository === "string"
    ? manifest.repository
    : manifest.repository?.url ?? manifest.homepage ?? "not declared";
  runtimePackages.push({
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? "not declared",
    repository: repository.replace(/^git\+/, ""),
    licenseFiles,
  });
}

runtimePackages.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en"));
const duplicate = runtimePackages.find((item, index) => (
  index > 0
  && item.name === runtimePackages[index - 1].name
  && item.version === runtimePackages[index - 1].version
));
if (duplicate) throw new Error(`Duplicate runtime package path for ${duplicate.name}@${duplicate.version}`);

const sections = runtimePackages.map((item) => {
  const licenses = item.licenseFiles.map(({ filename, text }) => (
    `### Packaged ${filename}\n\n\`\`\`text\n${text.trim().replaceAll("\r\n", "\n")}\n\`\`\``
  )).join("\n\n");
  return `## ${item.name}@${item.version}\n\n- Declared license: ${item.license}\n- Source: ${item.repository}\n\n${licenses}`;
});

const notice = `# Third-Party Notices\n\nThis file is generated from the production dependency graph locked for bitcoin-p2p-check v${rootManifest.version}. It intentionally includes the complete runtime dependency graph as a conservative superset of code that may be present in browser or Worker bundles. Build tools and test-only packages are documented in the release SBOM instead.\n\nGeneration verifies that every listed package ships a license or notice file. This inventory does not grant a license to this project and does not replace artifact-level license scanning or legal approval. Regenerate with \`npm run notices:generate\` after dependency changes and verify with \`npm run notices:check\`.\n\n${sections.join("\n\n")}\n`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing.replaceAll("\r\n", "\n") !== notice) {
    throw new Error("THIRD_PARTY_NOTICES.md is missing or does not match the locked runtime dependencies");
  }
  console.log(`Verified ${runtimePackages.length} locked runtime package notices.`);
} else {
  await writeFile(outputPath, notice, "utf8");
  console.log(`Generated notices for ${runtimePackages.length} locked runtime packages.`);
}
