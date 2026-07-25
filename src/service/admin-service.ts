import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createBackup } from "../backup/service.js";
import { builtInSkillsDirectory } from "../skills/paths.js";
import { SkillRegistry } from "../skills/registry.js";
import { conversations, groups, identities, persistentStatus } from "./admin-queries.js";
import type { IMGentApplication, ReadinessReport } from "./application.js";
import type { CreateScheduleInput, UpdateScheduleInput } from "../schedule/service.js";

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

  confirmPairing(code: string): Record<string, unknown> {
    return {
      result: "paired",
      ...this.application.identity.confirmPairing(code),
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
