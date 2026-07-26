import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { IMGentError, type SupportedLocale } from "@imgent/contracts";
import { createBackup } from "../backup/service.js";
import {
  getMemoryRecord,
  listMemoryRecords,
  memoryCurationStatus,
  type MemoryAuditRecord,
  type MemoryListInput,
  type MemoryRecordPage,
} from "../memory/admin.js";
import { builtInSkillsDirectory } from "../skills/paths.js";
import { SkillRegistry } from "../skills/registry.js";
import { conversations, groups, identities, persistentStatus } from "./admin-queries.js";
import type { IMGentApplication, ReadinessReport } from "./application.js";
import type {
  CreateScheduleInput,
  StoredSchedule,
  UpdateScheduleInput,
} from "../schedule/service.js";

type ScheduleNoticeAction = "created" | "updated" | "paused" | "resumed" | "removed";

function scheduleNotice(
  action: ScheduleNoticeAction,
  schedule: StoredSchedule,
): Record<SupportedLocale, string> {
  const zhActions: Record<ScheduleNoticeAction, string> = {
    created: "已创建",
    updated: "已修改",
    paused: "已暂停",
    resumed: "已恢复",
    removed: "已删除",
  };
  const enActions: Record<ScheduleNoticeAction, string> = {
    created: "Created",
    updated: "Updated",
    paused: "Paused",
    resumed: "Resumed",
    removed: "Removed",
  };
  const zhStatuses: Record<StoredSchedule["status"], string> = {
    active: "运行中",
    paused: "已暂停",
    completed: "已完成",
    blocked: "已阻塞",
  };
  const enStatuses: Record<StoredSchedule["status"], string> = {
    active: "Active",
    paused: "Paused",
    completed: "Completed",
    blocked: "Blocked",
  };
  const zh = [
    `${zhActions[action]}定时任务`,
    `任务：${schedule.name}`,
    `状态：${action === "removed" ? "已删除" : zhStatuses[schedule.status]}`,
    schedule.scheduleKind === "cron"
      ? `计划：Cron ${schedule.scheduleExpression}`
      : `执行时间：${schedule.scheduleExpression}`,
    ...(schedule.timezone ? [`时区：${schedule.timezone}`] : []),
    ...(schedule.nextRunAt ? [`下次执行：${schedule.nextRunAt}`] : []),
  ].join("\n");
  const en = [
    `${enActions[action]} scheduled task`,
    `Task: ${schedule.name}`,
    `Status: ${action === "removed" ? "Removed" : enStatuses[schedule.status]}`,
    schedule.scheduleKind === "cron"
      ? `Schedule: Cron ${schedule.scheduleExpression}`
      : `Run at: ${schedule.scheduleExpression}`,
    ...(schedule.timezone ? [`Timezone: ${schedule.timezone}`] : []),
    ...(schedule.nextRunAt ? [`Next run: ${schedule.nextRunAt}`] : []),
  ].join("\n");
  return { "zh-CN": zh, "en-US": en };
}

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
    const nextSteps = this.application.queuePendingGroupAuthorizations(pairing.platformIdentityId);
    return {
      result: "paired",
      ...pairing,
      nextSteps,
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

  memoryRecords(input: MemoryListInput): MemoryRecordPage {
    return listMemoryRecords(this.application.store, input);
  }

  memoryRecord(id: string): MemoryAuditRecord {
    const record = getMemoryRecord(this.application.store, id);
    if (!record) throw new IMGentError("MEMORY_RECORD_NOT_FOUND");
    return record;
  }

  memoryCurationStatus(): Record<string, unknown> {
    return memoryCurationStatus(this.application.store);
  }

  schedules(): unknown[] {
    return this.application.schedules.list();
  }

  async createSchedule(input: CreateScheduleInput): Promise<StoredSchedule> {
    const schedule = this.application.schedules.create(input);
    await this.notifySchedule("created", schedule);
    return schedule;
  }

  async updateSchedule(id: string, input: UpdateScheduleInput): Promise<StoredSchedule> {
    const schedule = this.application.schedules.update(id, input);
    await this.notifySchedule("updated", schedule);
    return schedule;
  }

  async pauseSchedule(id: string): Promise<StoredSchedule> {
    const schedule = this.application.schedules.setStatus(id, "paused");
    await this.notifySchedule("paused", schedule);
    return schedule;
  }

  async resumeSchedule(id: string): Promise<StoredSchedule> {
    const schedule = this.application.schedules.setStatus(id, "active");
    await this.notifySchedule("resumed", schedule);
    return schedule;
  }

  async removeSchedule(id: string): Promise<Record<string, unknown>> {
    const schedule = this.application.schedules.remove(id);
    await this.notifySchedule("removed", schedule);
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

  async authorizeGroup(
    conversationSpaceId: string,
    principalId: string,
  ): Promise<Record<string, unknown>> {
    this.application.identity.authorizeGroup(conversationSpaceId, principalId);
    await this.application.notifyConversation({
      conversationSpaceId,
      principalId,
      status: "group-authorization",
      body: {
        "zh-CN": "本群授权成功，现在可以 @机器人运行 Agent。",
        "en-US": "This group is now authorized. Mention the bot to run the Agent.",
      },
      idempotencyKey: `group-authorization-notice:${conversationSpaceId}:${randomUUID()}`,
      category: "group-authorization",
      action: "authorized",
      subjectId: conversationSpaceId,
    });
    return {
      result: "group-authorized",
      conversationSpaceId,
      principalId,
    };
  }

  private async notifySchedule(
    action: ScheduleNoticeAction,
    schedule: StoredSchedule,
  ): Promise<void> {
    await this.application.notifyConversation({
      conversationSpaceId: schedule.conversationSpaceId,
      principalId: schedule.principalId,
      status: "schedule",
      body: scheduleNotice(action, schedule),
      idempotencyKey: `schedule-notice:${schedule.id}:${action}:${randomUUID()}`,
      category: "schedule",
      action,
      subjectId: schedule.id,
    });
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
