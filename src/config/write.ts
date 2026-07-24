import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { IMGentError } from "@imgent/contracts";
import { configSchema } from "./schema.js";
import type { IMGentConfig } from "@imgent/contracts";

export async function readRawConfig(path: string): Promise<IMGentConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  } catch (error) {
    throw new IMGentError("CONFIG_FILE_UNREADABLE", {
      cause: error,
      diagnostic: { path: resolve(path) },
    });
  }
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    throw new IMGentError("CONFIG_FILE_INVALID", {
      diagnostic: {
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          code: issue.code,
        })),
      },
    });
  }
  return parsed.data as IMGentConfig;
}

export async function writeConfig(
  path: string,
  config: IMGentConfig,
  overwrite = true,
): Promise<void> {
  const validated = configSchema.parse(config);
  const finalPath = resolve(path);
  await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
  if (!overwrite) {
    try {
      await stat(finalPath);
      throw new IMGentError("CONFIG_FILE_INVALID", {
        diagnostic: { path: finalPath, reason: "already exists" },
      });
    } catch (error) {
      if (error instanceof IMGentError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const temporary = `${finalPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, finalPath);
    await chmod(finalPath, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function updateConfig(
  path: string,
  transform: (config: IMGentConfig) => IMGentConfig,
): Promise<IMGentConfig> {
  const next = transform(await readRawConfig(path));
  await writeConfig(path, next);
  return next;
}
