import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { configSchema } from "./schema.js";
import type { AgentPigeonConfig } from "@agent-pigeon/contracts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isInside(path: string, root: string): boolean {
  const result = relative(root, path);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

export async function loadConfig(path: string): Promise<AgentPigeonConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new ConfigError(
      `无法读取配置 ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`配置无效: ${details}`);
  }

  const base = dirname(resolve(path));
  const allowedRoots = await Promise.all(
    (parsed.data.allowedWorkspaceRoots ?? parsed.data.agentProfiles.map((p) => p.workspace)).map(
      async (entry) => {
        const candidate = resolve(base, entry);
        try {
          return await realpath(candidate);
        } catch {
          throw new ConfigError(`允许的工作区根不存在: ${candidate}`);
        }
      },
    ),
  );

  const profiles = await Promise.all(
    parsed.data.agentProfiles.map(async (profile) => {
      const candidate = resolve(base, profile.workspace);
      let workspace: string;
      try {
        workspace = await realpath(candidate);
      } catch {
        throw new ConfigError(`AgentProfile ${profile.id} 的工作区不存在: ${candidate}`);
      }
      if (!allowedRoots.some((root) => isInside(workspace, root))) {
        throw new ConfigError(`AgentProfile ${profile.id} 的工作区超出 allowedWorkspaceRoots`);
      }
      return {
        id: profile.id,
        driver: profile.driver,
        command: profile.command,
        workspace,
        ...(profile.prompt ? { prompt: profile.prompt } : {}),
        permissions: profile.permissions,
        memory: profile.memory,
      };
    }),
  );

  return {
    ...parsed.data,
    dataDir: resolve(base, parsed.data.dataDir),
    allowedWorkspaceRoots: allowedRoots,
    agentProfiles: profiles,
    bots: parsed.data.bots.map((bot) => ({
      id: bot.id,
      adapter: bot.adapter,
      credentialRef: bot.credentialRef,
      ...(bot.adapter === "qq"
        ? {
            transport: bot.transport,
            ...(bot.platformBotId ? { platformBotId: bot.platformBotId } : {}),
            ...(bot.platformBotIdEnv ? { platformBotIdEnv: bot.platformBotIdEnv } : {}),
            groupIngestionDefault: bot.groupIngestionDefault,
          }
        : {
            ...(bot.platformBotId ? { platformBotId: bot.platformBotId } : {}),
            ...(bot.authorizingPlatformUserId
              ? {
                  authorizingPlatformUserId: bot.authorizingPlatformUserId,
                }
              : {}),
            ...(bot.baseUrl ? { baseUrl: bot.baseUrl } : {}),
          }),
      enabled: bot.enabled,
    })),
  };
}

export function defaultConfig(workspace: string): AgentPigeonConfig {
  return {
    version: 1,
    dataDir: "./data",
    server: { host: "127.0.0.1", port: 8787 },
    allowedWorkspaceRoots: [workspace],
    agentProfiles: [],
    bots: [],
    routes: [],
  };
}
