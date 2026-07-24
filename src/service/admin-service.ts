import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createBackup } from "../backup/service.js";
import { builtInSkillsDirectory } from "../skills/paths.js";
import { SkillRegistry } from "../skills/registry.js";
import type { IMGentApplication, ReadinessReport } from "./application.js";

export class AdminService {
  constructor(readonly application: IMGentApplication) {}

  async status(readiness?: ReadinessReport): Promise<Record<string, unknown>> {
    const { store } = this.application;
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
      readiness: readiness ?? (await this.application.checkReady()),
    };
  }

  readiness() {
    return this.application.checkReady();
  }

  identities(): unknown[] {
    return this.application.store.all(
      `SELECT pi.id AS platformIdentityId, pi.agent_profile_id AS agentProfileId,
              pi.platform, pi.bot_instance_id AS botInstanceId,
              pi.platform_user_id AS platformUserId, pi.principal_id AS principalId,
              pi.display_name AS displayName, pi.paired
       FROM platform_identities pi
       ORDER BY pi.created_at`,
    );
  }

  confirmPairing(code: string): Record<string, unknown> {
    return {
      result: "paired",
      ...this.application.identity.confirmPairing(code),
    };
  }

  groups(): unknown[] {
    return this.application.store.all(
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

  authorizeGroup(conversationSpaceId: string, principalId: string): Record<string, unknown> {
    this.application.identity.authorizeGroup(conversationSpaceId, principalId);
    return {
      result: "group-authorized",
      conversationSpaceId,
      principalId,
    };
  }

  skills(): unknown[] {
    return this.application.skills.all().map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      files: skill.files,
      bytes: skill.bytes,
    }));
  }

  async validateSkills(): Promise<Record<string, unknown>> {
    const registry = await SkillRegistry.load(
      await builtInSkillsDirectory(),
      join(this.application.config.dataDir, "skills"),
    );
    const profiles = this.application.config.agentProfiles.map((entry) => ({
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

  async createControlledBackup(): Promise<{ artifact: string; files: number; bytes: number }> {
    const directory = join(this.application.config.dataDir, "run", "backups");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const artifact = `${randomUUID()}.backup`;
    const result = await createBackup(this.application.configPath, join(directory, artifact), {
      store: this.application.store,
      config: this.application.config,
    });
    return { artifact, files: result.files, bytes: result.bytes };
  }
}
