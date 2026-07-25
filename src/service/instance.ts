import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { IMGentError } from "@imgent/contracts";
import {
  CONTROL_APP_VERSION,
  CONTROL_PROTOCOL_VERSION,
  type ServiceState,
} from "../control/protocol.js";

const UNIX_SOCKET_PATH_LIMIT = process.platform === "darwin" ? 103 : 107;

export interface InstanceEndpoint {
  dataDir: string;
  instanceKey: string;
  endpoint: string;
  metadataPath: string;
}

export interface InstanceMetadata {
  instanceId: string;
  pid: number;
  startedAt: string;
  appVersion: string;
  protocolVersion: number;
  instanceKey: string;
  endpoint: string;
  configPath: string;
  configHash: string;
  state: ServiceState;
}

let cachedUserKey: Promise<string> | undefined;

function windowsSid(): Promise<string | undefined> {
  return new Promise((resolveSid) => {
    execFile(
      "whoami",
      ["/user", "/fo", "csv", "/nh"],
      { timeout: 2_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolveSid(undefined);
          return;
        }
        resolveSid(stdout.match(/\bS-\d-\d+(?:-\d+)+\b/i)?.[0]);
      },
    );
  });
}

async function userKey(): Promise<string> {
  if (typeof process.getuid === "function") return String(process.getuid());
  cachedUserKey ??= (async () => {
    const identity =
      (process.platform === "win32" ? await windowsSid() : undefined) ??
      `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? "unknown"}`;
    return createHash("sha256").update(identity.toUpperCase()).digest("hex").slice(0, 16);
  })();
  return cachedUserKey;
}

async function canonicalDataDir(dataDir: string, create: boolean): Promise<string> {
  const absolute = resolve(dataDir);
  if (create) await mkdir(absolute, { recursive: true, mode: 0o700 });
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
    throw error;
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new IMGentError("STORAGE_UNAVAILABLE");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new IMGentError("STORAGE_UNAVAILABLE");
  }
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    throw new IMGentError("STORAGE_UNAVAILABLE");
  }
  return canonical;
}

async function secureRuntimeDirectory(): Promise<string> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const root = join("/tmp", `imgent-${await userKey()}`);
  let existed = true;
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new IMGentError("RUNTIME_INSTANCE_CONFLICT");
  }
  if (uid !== undefined && info.uid !== uid) {
    throw new IMGentError("RUNTIME_INSTANCE_CONFLICT");
  }
  if (process.platform !== "win32") {
    if (!existed) await chmod(root, 0o700);
    const mode = (await stat(root)).mode & 0o777;
    if (mode !== 0o700) throw new IMGentError("RUNTIME_INSTANCE_CONFLICT");
  }
  return root;
}

export async function resolveInstanceEndpoint(
  dataDir: string,
  options: { createDataDir?: boolean } = {},
): Promise<InstanceEndpoint> {
  const canonical = await canonicalDataDir(dataDir, options.createDataDir ?? false);
  const currentUserKey = await userKey();
  const instanceKey = createHash("sha256")
    .update(`${currentUserKey}\0${canonical}`)
    .digest("hex")
    .slice(0, 24);
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\imgent-${currentUserKey}-${instanceKey}`
      : join(await secureRuntimeDirectory(), `${instanceKey}.sock`);
  if (process.platform !== "win32" && Buffer.byteLength(endpoint) > UNIX_SOCKET_PATH_LIMIT) {
    throw new IMGentError("RUNTIME_INSTANCE_CONFLICT");
  }
  return {
    dataDir: canonical,
    instanceKey,
    endpoint,
    metadataPath: join(canonical, "run", "instance.json"),
  };
}

export async function endpointEntryKind(
  endpoint: InstanceEndpoint,
): Promise<"absent" | "socket" | "unsafe"> {
  if (process.platform === "win32") return "absent";
  try {
    const info = await lstat(endpoint.endpoint);
    if (info.isSymbolicLink() || !info.isSocket()) return "unsafe";
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return "unsafe";
    return "socket";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

export async function removeStaleEndpoint(endpoint: InstanceEndpoint): Promise<void> {
  if (process.platform === "win32") return;
  const kind = await endpointEntryKind(endpoint);
  if (kind !== "socket") throw new IMGentError("RUNTIME_INSTANCE_CONFLICT");
  await rm(endpoint.endpoint);
}

export async function writeInstanceMetadata(
  endpoint: InstanceEndpoint,
  metadata: Omit<InstanceMetadata, "appVersion" | "protocolVersion" | "instanceKey" | "endpoint">,
): Promise<void> {
  await mkdir(join(endpoint.dataDir, "run"), { recursive: true, mode: 0o700 });
  const value: InstanceMetadata = {
    ...metadata,
    appVersion: CONTROL_APP_VERSION,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    instanceKey: endpoint.instanceKey,
    endpoint: endpoint.endpoint,
  };
  const temporary = `${endpoint.metadataPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, endpoint.metadataPath);
  await chmod(endpoint.metadataPath, 0o600);
}

export async function readInstanceMetadata(
  endpoint: InstanceEndpoint,
): Promise<InstanceMetadata | undefined> {
  try {
    return JSON.parse(await readFile(endpoint.metadataPath, "utf8")) as InstanceMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function removeInstanceMetadata(endpoint: InstanceEndpoint): Promise<void> {
  await rm(endpoint.metadataPath, { force: true });
}
