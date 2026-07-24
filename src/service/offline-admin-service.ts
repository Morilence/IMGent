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

  persistentStatus(): Record<string, unknown> {
    const { store } = this.context;
    return {
      database: store.status(),
      transports: store.all(
        `SELECT bot_instance_id AS botInstanceId,
                checkpoint_key AS checkpointKey, value, updated_at AS updatedAt
         FROM transport_checkpoints
         ORDER BY bot_instance_id, checkpoint_key`,
      ),
      lastInboundByBot: store.all(
        `SELECT bot_instance_id AS botInstanceId,
                max(received_at) AS lastReceivedAt
         FROM inbound_events GROUP BY bot_instance_id
         ORDER BY bot_instance_id`,
      ),
      groups: store.all(
        `SELECT cs.bot_instance_id AS botInstanceId, gp.mode,
                gp.platform_full_capability AS platformFullCapability,
                count(*) AS count
         FROM group_policies gp
         JOIN conversation_spaces cs
           ON cs.id = gp.conversation_space_id
         GROUP BY cs.bot_instance_id, gp.mode, gp.platform_full_capability
         ORDER BY cs.bot_instance_id, gp.mode`,
      ),
      oldestWaitingTask:
        store.get(
          `SELECT id, conversation_key AS conversationKey, status,
                  created_at AS createdAt
           FROM tasks
           WHERE status IN ('queued', 'active', 'retry_wait', 'waiting_approval')
           ORDER BY created_at LIMIT 1`,
        ) ?? null,
    };
  }

  identities(): unknown[] {
    return this.context.store.all(
      `SELECT pi.id AS platformIdentityId, pi.agent_profile_id AS agentProfileId,
              pi.platform, pi.bot_instance_id AS botInstanceId,
              pi.platform_user_id AS platformUserId, pi.principal_id AS principalId,
              pi.display_name AS displayName, pi.paired
       FROM platform_identities pi
       ORDER BY pi.created_at`,
    );
  }

  groups(): unknown[] {
    return this.context.store.all(
      `SELECT cs.id AS conversationSpaceId, cs.agent_profile_id AS agentProfileId,
              cs.bot_instance_id AS botInstanceId,
              cs.platform_conversation_id AS platformConversationId,
              gp.mode, gp.platform_full_capability AS platformFullCapability,
              CASE WHEN ga.conversation_space_id IS NULL THEN 0 ELSE 1 END AS authorized
       FROM conversation_spaces cs
       JOIN group_policies gp ON gp.conversation_space_id = cs.id
       LEFT JOIN group_authorizations ga ON ga.conversation_space_id = cs.id
       WHERE cs.kind = 'group'
       ORDER BY cs.created_at`,
    );
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
          profiles[profile.id] = await driver.checkReady(profile);
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
    return { ready: issues.length === 0, issues, bots, profiles };
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
