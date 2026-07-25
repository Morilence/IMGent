import { IMGentError, normalizeError } from "@imgent/contracts";
import type { IMGentStore } from "../storage/store.js";
import type {
  AgentDriver,
  AgentProfile,
  ErrorDescriptor,
  IMGentConfig,
  ImAdapter,
} from "@imgent/contracts";

export interface ReadinessReport {
  ready: boolean;
  checkedAt: string;
  depth: "runtime" | "diagnostic";
  issues: ErrorDescriptor[];
  bots: Record<string, { ready: boolean; issues: ErrorDescriptor[] }>;
  profiles: Record<string, { ready: boolean; version?: string; issues: ErrorDescriptor[] }>;
}

export async function collectReadiness(
  options: {
    config: IMGentConfig;
    store: IMGentStore;
    profiles: ReadonlyMap<string, AgentProfile>;
    drivers: ReadonlyMap<string, AgentDriver>;
    adapters: ReadonlyMap<string, ImAdapter>;
    botAssemblyIssues: ReadonlyMap<string, ErrorDescriptor[]>;
    adapterStartIssues: ReadonlyMap<string, ErrorDescriptor[]>;
  },
  depth: "runtime" | "diagnostic",
): Promise<ReadinessReport> {
  const issues: ErrorDescriptor[] = [];
  const bots: ReadinessReport["bots"] = {};
  const profiles: ReadinessReport["profiles"] = {};
  try {
    options.store.database.prepare("SELECT 1").get();
    options.store.database.exec("CREATE TEMP TABLE IF NOT EXISTS readiness_probe(value INTEGER)");
    options.store.database.exec("DELETE FROM readiness_probe");
  } catch (error) {
    issues.push(normalizeError(error, "STORAGE_UNAVAILABLE").descriptor);
  }
  for (const bot of options.config.bots) {
    if (bot.enabled === false) continue;
    const assemblyIssues = options.botAssemblyIssues.get(bot.id);
    const startIssues = options.adapterStartIssues.get(bot.id);
    if (assemblyIssues || startIssues) {
      bots[bot.id] = {
        ready: false,
        issues: [...(assemblyIssues ?? []), ...(startIssues ?? [])],
      };
    }
  }
  await Promise.all(
    [...options.drivers.entries()].map(async ([profileId, driver]) => {
      const profile = options.profiles.get(profileId);
      if (!profile) return;
      try {
        const result = await driver.checkReady(profile, depth);
        profiles[profileId] = {
          ready: result.ready,
          ...(result.version ? { version: result.version } : {}),
          issues: result.issues,
        };
      } catch (error) {
        profiles[profileId] = {
          ready: false,
          issues: [normalizeError(error, "AGENT_UNAVAILABLE").descriptor],
        };
      }
    }),
  );
  await Promise.all(
    [...options.adapters.entries()].map(async ([botId, adapter]) => {
      try {
        const result = await adapter.checkReady(depth);
        const startIssues = options.adapterStartIssues.get(botId) ?? [];
        bots[botId] = {
          ready: result.ready && startIssues.length === 0,
          issues: [...result.issues, ...startIssues],
        };
      } catch (error) {
        bots[botId] = {
          ready: false,
          issues: [normalizeError(error, "ADAPTER_CONNECTION_FAILED").descriptor],
        };
      }
    }),
  );
  const readyRoute = options.config.routes.some((route) => {
    const bot = options.config.bots.find((entry) => entry.id === route.botInstanceId);
    return (
      bot?.enabled !== false &&
      bots[route.botInstanceId]?.ready === true &&
      profiles[route.agentProfileId]?.ready === true
    );
  });
  if (!readyRoute) issues.push(new IMGentError("PROFILE_OR_DRIVER_MISSING").descriptor);
  return {
    ready: issues.length === 0,
    checkedAt: new Date().toISOString(),
    depth,
    issues,
    bots,
    profiles,
  };
}
