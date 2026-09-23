import { readFile, writeFile } from "node:fs/promises";
import { readBuildIdentity } from "./build-identity.mjs";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const marker = 'const BUILD_ID = "development";';
if (source.split(marker).length !== 2) throw new Error("Service Worker build marker is missing or ambiguous");
const commit = readBuildIdentity();
await writeFile(new URL("../dist/client/sw.js", import.meta.url), source.replace(marker, `const BUILD_ID = "${commit}";`));
console.log(`Service Worker cache identity: ${commit}`);
