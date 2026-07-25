import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { backup } from "node:sqlite";
import { configSchema } from "../config/schema.js";
import { CredentialStore } from "../security/credential-store.js";
import { SCHEMA_VERSION } from "../storage/migrations.js";
import { IMGentStore } from "../storage/store.js";
import type { IMGentConfig } from "@imgent/contracts";

interface ArchiveFile {
  path: string;
  size: number;
  sha256: string;
  content: string;
  mode?: number;
}

interface BackupArchive {
  format: "imgent-backup/v2";
  manifest: {
    createdAt: string;
    schemaVersion: number;
    sensitive: true;
    externalAgentAuthenticationIncluded: false;
    files: Array<Omit<ArchiveFile, "content">>;
  };
  files: ArchiveFile[];
}

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function archiveFile(path: string, value: Buffer, mode?: number): ArchiveFile {
  return {
    path,
    size: value.byteLength,
    sha256: checksum(value),
    content: value.toString("base64"),
    ...(mode === undefined ? {} : { mode }),
  };
}

export async function createBackup(
  configPath: string,
  outputPath: string,
  options: { store?: IMGentStore; config?: IMGentConfig } = {},
): Promise<{ path: string; files: number; bytes: number }> {
  const rawConfig = options.config
    ? Buffer.from(`${JSON.stringify(options.config, null, 2)}\n`)
    : await readFile(configPath);
  const parsed = configSchema.safeParse(JSON.parse(rawConfig.toString("utf8")));
  if (!parsed.success) throw new Error("配置无效，拒绝备份");
  const base = dirname(resolve(configPath));
  const dataDir = resolve(base, parsed.data.dataDir);
  const credentials = new CredentialStore(dataDir);
  const store =
    options.store ??
    (await IMGentStore.open(join(dataDir, "imgent.sqlite"), await credentials.secretBox()));
  const ownsStore = options.store === undefined;
  const snapshotPath = join(dataDir, `.backup-${process.pid}-${randomUUID()}.sqlite`);
  try {
    await backup(store.database, snapshotPath);
    const files: ArchiveFile[] = [
      archiveFile("config.json", rawConfig),
      archiveFile("data/imgent.sqlite", await readFile(snapshotPath)),
      archiveFile("data/credentials.key", await readFile(join(dataDir, "credentials.key"))),
    ];
    try {
      for (const name of await readdir(join(dataDir, "credentials"))) {
        if (!name.endsWith(".enc")) continue;
        files.push(
          archiveFile(
            `data/credentials/${name}`,
            await readFile(join(dataDir, "credentials", name)),
          ),
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    files.push(...(await archiveSkillFiles(dataDir)));
    const archive: BackupArchive = {
      format: "imgent-backup/v2",
      manifest: {
        createdAt: new Date().toISOString(),
        schemaVersion: SCHEMA_VERSION,
        sensitive: true,
        externalAgentAuthenticationIncluded: false,
        files: files.map(({ path, size, sha256, mode }) => ({
          path,
          size,
          sha256,
          ...(mode === undefined ? {} : { mode }),
        })),
      },
      files,
    };
    const finalPath = resolve(outputPath);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    const temporary = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(archive), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, finalPath);
      await chmod(finalPath, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      path: finalPath,
      files: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
    };
  } finally {
    if (ownsStore) store.close();
    await rm(snapshotPath, { force: true });
  }
}

export async function restoreBackup(
  archivePath: string,
  targetDataDir: string,
  targetConfigPath: string,
  overwrite = false,
): Promise<{ dataDir: string; configPath: string; files: number }> {
  const archive = JSON.parse(
    await readFile(resolve(archivePath), "utf8"),
  ) as Partial<BackupArchive>;
  if (archive.format !== "imgent-backup/v2" || !archive.manifest || !Array.isArray(archive.files)) {
    throw new Error("备份 manifest 或格式无效");
  }
  if (archive.manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `备份 schema version ${archive.manifest.schemaVersion} 与当前 ${SCHEMA_VERSION} 不兼容`,
    );
  }
  const manifestByPath = new Map(archive.manifest.files.map((file) => [file.path, file]));
  const archivePaths = new Set(archive.files.map((file) => file.path));
  if (
    archivePaths.size !== archive.files.length ||
    archive.manifest.files.length !== archive.files.length
  ) {
    throw new Error("备份 manifest 包含重复或数量不一致的文件记录");
  }
  for (const required of ["config.json", "data/imgent.sqlite", "data/credentials.key"]) {
    if (!archivePaths.has(required) || !manifestByPath.has(required)) {
      throw new Error(`备份缺少必要文件: ${required}`);
    }
  }
  for (const file of archive.files) {
    const expected = manifestByPath.get(file.path);
    const content = Buffer.from(file.content, "base64");
    if (
      !expected ||
      expected.size !== content.byteLength ||
      expected.sha256 !== checksum(content) ||
      file.sha256 !== expected.sha256 ||
      file.mode !== expected.mode
    ) {
      throw new Error(`备份文件校验失败: ${file.path}`);
    }
  }
  const allowed = new Set(["config.json", "data/imgent.sqlite", "data/credentials.key"]);
  for (const file of archive.files) {
    if (
      !allowed.has(file.path) &&
      !/^data\/credentials\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.enc$/.test(file.path) &&
      !safeSkillArchivePath(file.path)
    ) {
      throw new Error(`备份包含不安全路径: ${file.path}`);
    }
    if (file.path.startsWith("data/skills/") && file.mode !== 0o600 && file.mode !== 0o700) {
      throw new Error(`备份包含不安全的 skill 文件权限: ${file.path}`);
    }
  }

  const dataDir = resolve(targetDataDir);
  const configPath = resolve(targetConfigPath);
  if (!overwrite) {
    const existing = await existingEntries(dataDir);
    if (existing.length > 0) {
      throw new Error("恢复目标数据目录不是空目录；如需覆盖请显式使用 --force");
    }
    try {
      await stat(configPath);
      throw new Error("目标配置文件已存在；如需覆盖请显式使用 --force");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("目标配置文件")) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(join(dataDir, "credentials"), {
    recursive: true,
    mode: 0o700,
  });
  if (overwrite) {
    await rm(join(dataDir, "imgent.sqlite-wal"), { force: true });
    await rm(join(dataDir, "imgent.sqlite-shm"), { force: true });
  }
  for (const file of archive.files) {
    if (file.path === "config.json") continue;
    const target =
      file.path === "data/imgent.sqlite"
        ? join(dataDir, "imgent.sqlite")
        : file.path === "data/credentials.key"
          ? join(dataDir, "credentials.key")
          : file.path.startsWith("data/credentials/")
            ? join(dataDir, "credentials", file.path.slice("data/credentials/".length))
            : join(dataDir, file.path.slice("data/".length));
    await writeAtomic(target, Buffer.from(file.content, "base64"), file.mode ?? 0o600, overwrite);
  }
  const configFile = archive.files.find((file) => file.path === "config.json");
  if (!configFile) throw new Error("备份缺少 config.json");
  const config = configSchema.parse(
    JSON.parse(Buffer.from(configFile.content, "base64").toString("utf8")),
  );
  const restoredConfig = {
    ...config,
    dataDir: relative(dirname(configPath), dataDir) || ".",
  };
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeAtomic(
    configPath,
    Buffer.from(`${JSON.stringify(restoredConfig, null, 2)}\n`),
    0o600,
    overwrite,
  );

  const credentials = new CredentialStore(dataDir);
  const store = await IMGentStore.open(
    join(dataDir, "imgent.sqlite"),
    await credentials.secretBox(),
  );
  try {
    const integrity = store.get<{ integrity_check: string }>("PRAGMA integrity_check");
    if (integrity?.integrity_check !== "ok") {
      throw new Error("恢复后的 SQLite integrity_check 失败");
    }
  } finally {
    store.close();
  }
  return {
    dataDir,
    configPath,
    files: archive.files.length,
  };
}

async function archiveSkillFiles(dataDir: string): Promise<ArchiveFile[]> {
  const root = join(dataDir, "skills");
  const files: ArchiveFile[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`拒绝备份 skill 符号链接: ${path}`);
      if (metadata.isDirectory()) {
        await visit(path, relativePath);
      } else if (metadata.isFile()) {
        files.push(
          archiveFile(
            `data/skills/${relativePath.split("\\").join("/")}`,
            await readFile(path),
            metadata.mode & 0o111 ? 0o700 : 0o600,
          ),
        );
      } else {
        throw new Error(`拒绝备份 skill 特殊文件: ${path}`);
      }
    }
  };
  try {
    await visit(root, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return files;
}

function safeSkillArchivePath(path: string): boolean {
  if (!path.startsWith("data/skills/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  const segments = path.slice("data/skills/".length).split("/");
  return (
    segments.length >= 2 &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

async function existingEntries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeAtomic(
  path: string,
  value: Buffer,
  mode: number,
  overwrite: boolean,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode, flag: "wx" });
  try {
    if (!overwrite) {
      try {
        await stat(path);
        throw new Error(`目标已存在: ${path}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("目标已存在")) {
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
