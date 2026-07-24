import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { IMGentError } from "@imgent/contracts";
import { configSchema } from "./schema.js";
import type { IMGentConfig } from "@imgent/contracts";

function isInside(path: string, root: string): boolean {
  const result = relative(root, path);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

export async function loadConfig(path: string): Promise<IMGentConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new IMGentError("CONFIG_FILE_UNREADABLE", {
      cause: error,
      diagnostic: { path },
    });
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new IMGentError("CONFIG_FILE_INVALID", {
      diagnostic: { issues: details },
    });
  }

  const base = dirname(resolve(path));
  const allowedRoots = await Promise.all(
    (parsed.data.allowedWorkspaceRoots ?? parsed.data.agentProfiles.map((p) => p.workspace)).map(
      async (entry) => {
        const candidate = resolve(base, entry);
        try {
          return await realpath(candidate);
        } catch {
          throw new IMGentError("CONFIG_WORKSPACE_INVALID", {
            diagnostic: { candidate, source: "allowedWorkspaceRoots" },
          });
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
        throw new IMGentError("CONFIG_WORKSPACE_INVALID", {
          diagnostic: { candidate, agentProfileId: profile.id },
        });
      }
      if (!allowedRoots.some((root) => isInside(workspace, root))) {
        throw new IMGentError("CONFIG_WORKSPACE_INVALID", {
          diagnostic: { workspace, agentProfileId: profile.id, reason: "outside roots" },
        });
      }
      return {
        id: profile.id,
        driver: profile.driver,
        command: profile.command,
        workspace,
        ...(profile.prompt ? { prompt: profile.prompt } : {}),
        skills: profile.skills,
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
      ...(bot.locale ? { locale: bot.locale } : {}),
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

export function defaultConfig(workspace: string): IMGentConfig {
  return {
    version: 1,
    defaultLocale: "zh-CN",
    dataDir: "./data",
    server: { host: "127.0.0.1", port: 8787 },
    allowedWorkspaceRoots: [workspace],
    agentProfiles: [],
    bots: [],
    routes: [],
  };
}
