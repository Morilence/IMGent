import { join } from "node:path";
import { IMGentError, normalizeError } from "@imgent/contracts";
import { ClaudeCodeDriver } from "@imgent/driver-claude-code";
import { CodexDriver } from "@imgent/driver-codex";
import { createBackup } from "../backup/service.js";
import { loadConfig } from "../config/index.js";
import { CredentialStore } from "../security/credential-store.js";
import { builtInSkillsDirectory } from "../skills/paths.js";
import { SkillRegistry } from "../skills/registry.js";
import { IMGentStore } from "../storage/store.js";
import { groups, identities, persistentStatus } from "./admin-queries.js";
import type { ReadinessReport } from "./application.js";

interface OfflineContext {
  config: Awaited<ReturnType<typeof loadConfig>>;
  credentials: CredentialStore;
  store: IMGentStore;
}

export class OfflineAdminService {
  private constructor(
    private readonly context: OfflineContext,
    readonly configPath: string,
  ) {}

  static async open(configPath: string): Promise<OfflineAdminService> {
    const config = await loadConfig(configPath);
    const credentials = new CredentialStore(config.dataDir);
    const store = await IMGentStore.open(
      join(config.dataDir, "imgent.sqlite"),
      await credentials.secretBox(),
    );
    return new OfflineAdminService({ config, credentials, store }, configPath);
  }

  close(): void {
    this.context.store.close();
  }

  setCredential(ref: string, value: Record<string, unknown>): Promise<void> {
    return this.context.credentials.set(ref, value);
  }

  persistentStatus(): Record<string, unknown> {
    return persistentStatus(this.context.store);
  }

  identities(): unknown[] {
    return identities(this.context.store);
  }

  groups(): unknown[] {
    return groups(this.context.store);
  }

  async skills(): Promise<unknown[]> {
    const registry = await this.registry();
    return registry.all().map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      files: skill.files,
      bytes: skill.bytes,
    }));
  }

  async validateSkills(): Promise<Record<string, unknown>> {
    const registry = await this.registry();
    const profiles = this.context.config.agentProfiles.map((entry) => ({
      profileId: entry.id,
      skills: registry.visible(entry.skills, entry.memory.enabled).map((skill) => skill.name),
    }));
    return {
      result: "valid",
      skills: registry.all().length,
      profiles,
      restartRequiredAfterChanges: true,
    };
  }

  async environmentReadiness(): Promise<ReadinessReport> {
    const issues: ReadinessReport["issues"] = [];
    const bots: ReadinessReport["bots"] = {};
    const profiles: ReadinessReport["profiles"] = {};
    await Promise.all(
      this.context.config.agentProfiles.map(async (profile) => {
        const driver = profile.driver === "codex" ? new CodexDriver() : new ClaudeCodeDriver();
        try {
          profiles[profile.id] = await driver.checkReady(profile, "diagnostic");
        } catch (error) {
          profiles[profile.id] = {
            ready: false,
            issues: [normalizeError(error, "AGENT_UNAVAILABLE").descriptor],
          };
        } finally {
          await driver.close?.();
        }
      }),
    );
    await Promise.all(
      this.context.config.bots.map(async (bot) => {
        if (bot.enabled === false) return;
        const credential = await this.context.credentials.get<Record<string, unknown>>(
          bot.credentialRef,
        );
        const configured =
          bot.adapter === "qq"
            ? Boolean(
                credential?.appSecret &&
                (bot.platformBotId || (bot.platformBotIdEnv && process.env[bot.platformBotIdEnv])),
              )
            : Boolean(credential?.botToken && bot.platformBotId);
        bots[bot.id] = configured
          ? { ready: true, issues: [] }
          : {
              ready: false,
              issues: [new IMGentError("ADAPTER_AUTH_REQUIRED").descriptor],
            };
      }),
    );
    const readyRoute = this.context.config.routes.some(
      (route) =>
        bots[route.botInstanceId]?.ready === true && profiles[route.agentProfileId]?.ready === true,
    );
    if (!readyRoute) issues.push(new IMGentError("PROFILE_OR_DRIVER_MISSING").descriptor);
    return {
      ready: issues.length === 0,
      checkedAt: new Date().toISOString(),
      depth: "diagnostic",
      issues,
      bots,
      profiles,
    };
  }

  createBackup(outputPath: string) {
    return createBackup(this.configPath, outputPath, { store: this.context.store });
  }

  private async registry(): Promise<SkillRegistry> {
    const registry = await SkillRegistry.load(
      await builtInSkillsDirectory(),
      join(this.context.config.dataDir, "skills"),
    );
    for (const profile of this.context.config.agentProfiles) {
      registry.visible(profile.skills, profile.memory.enabled);
    }
    return registry;
  }
}
