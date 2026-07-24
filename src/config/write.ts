import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { configSchema } from "./schema.js";
import type { IMGentConfig } from "@imgent/contracts";

export async function readRawConfig(path: string): Promise<IMGentConfig> {
  const value = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  return configSchema.parse(value) as IMGentConfig;
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
      throw new Error(`配置文件已存在: ${finalPath}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("配置文件已存在")) {
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
