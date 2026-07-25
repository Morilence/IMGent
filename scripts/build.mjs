import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const external = Object.keys(packageJson.dependencies ?? {});

await build({
  absWorkingDir: projectRoot,
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/src/cli/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external,
  sourcemap: true,
  sourcesContent: false,
  logLevel: "info",
});
