import { readFile, writeFile } from "node:fs/promises";

const sourceUrl = new URL("../app/globals.css", import.meta.url);
const outputUrl = new URL("../app/runtime-globals.css", import.meta.url);
const tailwindImport = /^@import\s+["']tailwindcss["'];\s*\r?\n+/;

const source = await readFile(sourceUrl, "utf8");
if (!tailwindImport.test(source)) {
  throw new Error("app/globals.css의 Tailwind import를 찾지 못했습니다.");
}

const output = source.replace(
  tailwindImport,
  '@import "./preflight.css";\n\n',
);

await writeFile(outputUrl, output, "utf8");
console.log("Generated app/runtime-globals.css without the Tailwind build pipeline");
