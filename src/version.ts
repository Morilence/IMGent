import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

export const IMGENT_VERSION = readPackageVersion();

function readPackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  while (true) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as PackageManifest;
      if (manifest.name === "imgent" && typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Unable to locate the imgent package manifest");
    }
    directory = parent;
  }
}
