import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { IMGentError } from "@imgent/contracts";
import { createBackup } from "../backup/service.js";
import { builtInSkillsDirectory } from "../skills/paths.js";
import { SkillRegistry } from "../skills/registry.js";
import { conversations, groups, identities, persistentStatus } from "./admin-queries.js";
import type { IMGentApplication, ReadinessReport } from "./application.js";
import type { CreateScheduleInput, UpdateScheduleInput } from "../schedule/service.js";

function isInside(path: string, root: string): boolean {
  const result = relative(root, path);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

export class AdminService {
  constructor(readonly application: IMGentApplication) {}

  async status(readiness?: ReadinessReport): Promise<Record<string, unknown>> {
    const { store } = this.application;
    return {
      ...persistentStatus(store),
      readiness: readiness ?? this.application.readiness(),
    };
  }

  identities(): unknown[] {
    return identities(this.application.store);
  }

  async confirmPairing(
    code: string,
    requestedWorkspace?: string,
  ): Promise<Record<string, unknown>> {
    const agentProfileId = this.application.identity.pairingAgentProfileId(code);
    const workspace = await this.resolveWorkspace(agentProfileId, requestedWorkspace);
    const pairing = this.application.identity.confirmPairing(
      code,
      workspace,
      requestedWorkspace !== undefined,
    );
    const pendingGroups = this.application.store.all<{
      conversationSpaceId: string;
      botInstanceId: string;
    }>(
      `SELECT cs.id AS conversationSpaceId, cs.bot_instance_id AS botInstanceId
       FROM conversation_spaces cs
       JOIN platform_identities pi
         ON pi.agent_profile_id = cs.agent_profile_id
       LEFT JOIN group_authorizations ga
         ON ga.conversation_space_id = cs.id
       WHERE pi.id = ? AND cs.kind = 'group'
         AND ga.conversation_space_id IS NULL
       ORDER BY cs.created_at`,
      pairing.platformIdentityId,
    );
    return {
      result: "paired",
      ...pairing,
      nextSteps: pendingGroups.map((group) => ({
        action: "authorize-group",
        conversationSpaceId: group.conversationSpaceId,
        botInstanceId: group.botInstanceId,
        command: `imgent group authorize ${group.conversationSpaceId} --principal ${pairing.principalId}`,
      })),
    };
  }

  async setIdentityWorkspace(
    principalId: string,
    requestedWorkspace: string,
  ): Promise<Record<string, unknown>> {
    const agentProfileId = this.application.identity.agentProfileId(principalId);
    const workspace = await this.resolveWorkspace(agentProfileId, requestedWorkspace);
    return {
      result: "workspace-updated",
      principalId,
      ...this.application.identity.setWorkspace(principalId, workspace),
    };
  }

  groups(): unknown[] {
    return groups(this.application.store);
  }

  conversations(): unknown[] {
    return conversations(this.application.store).map((conversation) => ({
      ...conversation,
      supportsProactiveSend:
        this.application.adapters.get(String(conversation.botInstanceId))?.capabilities
          .supportsProactiveSend ?? false,
    }));
  }

  schedules(): unknown[] {
    return this.application.schedules.list();
  }

  createSchedule(input: CreateScheduleInput): unknown {
    return this.application.schedules.create(input);
  }

  updateSchedule(id: string, input: UpdateScheduleInput): unknown {
    return this.application.schedules.update(id, input);
  }

  pauseSchedule(id: string): unknown {
    return this.application.schedules.setStatus(id, "paused");
  }

  resumeSchedule(id: string): unknown {
    return this.application.schedules.setStatus(id, "active");
  }

  removeSchedule(id: string): Record<string, unknown> {
    this.application.schedules.remove(id);
    return { result: "schedule-removed", id };
  }

  runSchedule(id: string): Record<string, unknown> {
    return { result: "schedule-enqueued", id, taskId: this.application.schedules.trigger(id) };
  }

  resetScheduleContext(id: string): unknown {
    return this.application.schedules.resetContext(id);
  }

  scheduleHistory(id: string): unknown[] {
    return this.application.schedules.history(id);
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

  private async resolveWorkspace(
    agentProfileId: string,
    requestedWorkspace?: string,
  ): Promise<string> {
    const profile = this.application.profiles.get(agentProfileId);
    if (!profile) throw new IMGentError("IDENTITY_OPERATION_REJECTED");
    const candidate = requestedWorkspace ?? profile.agentUserHome;
    if (!isAbsolute(candidate)) {
      throw new IMGentError("CONFIG_WORKSPACE_INVALID", {
        diagnostic: { candidate, reason: "workspace must be absolute" },
      });
    }
    let workspace: string;
    try {
      workspace = await realpath(candidate);
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("workspace is not a directory");
      }
    } catch (error) {
      throw new IMGentError("CONFIG_WORKSPACE_INVALID", {
        cause: error,
        diagnostic: { candidate },
      });
    }
    const allowedRoots = [
      profile.agentUserHome,
      ...(this.application.config.allowedWorkspaceRoots ?? []),
    ];
    if (!allowedRoots.some((root) => isInside(workspace, root))) {
      throw new IMGentError("CONFIG_WORKSPACE_INVALID", {
        diagnostic: { workspace, reason: "outside roots" },
      });
    }
    return workspace;
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
