import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourceDist = path.join(directory, "dist");
const outputRoot = path.resolve(directory, "../dist/mini-app");
const outputAssets = path.join(outputRoot, "assets");

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputAssets, { recursive: true });
await fs.copyFile(path.join(directory, "index.html"), path.join(outputRoot, "index.html"));
await fs.copyFile(path.join(directory, "styles.css"), path.join(outputAssets, "styles.css"));

for (const entry of await fs.readdir(sourceDist, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) {
    continue;
  }
  await fs.copyFile(path.join(sourceDist, entry.name), path.join(outputAssets, entry.name));
}
