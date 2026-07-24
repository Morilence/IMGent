import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function builtInSkillsDirectory(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../../skills"),
    resolve(moduleDirectory, "../../../skills"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the source-tree or compiled-tree alternative.
    }
  }
  throw new Error(`找不到 IMGent 内置 skills 目录: ${candidates.join(", ")}`);
}
