import { textOf } from "@imgent/contracts";
import { CURATION_SKILL, type SkillRegistry } from "../skills/registry.js";
import type { MemoryContext, MemoryService } from "./service.js";
import type { IMGentHostTools } from "../runtime/host-tools.js";
import type { IMGentStore } from "../storage/store.js";
import type { AgentDriver, AgentProfile } from "@imgent/contracts";

const CURATOR_TOOLS = ["memory.search", "memory.remember"] as const;

function now(): string {
  return new Date().toISOString();
}

export interface MemoryCuratorOptions {
  store: IMGentStore;
  memory: MemoryService;
  profiles: ReadonlyMap<string, AgentProfile>;
  drivers: ReadonlyMap<string, AgentDriver>;
  hostTools: IMGentHostTools;
  skills: SkillRegistry;
}

export class MemoryCurator {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: MemoryCuratorOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processOnce();
    }, 1_000);
    this.timer.unref();
    void this.processOnce();
  }

  async processOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const row = this.options.store.transaction(() => {
        const pending = this.options.store.get<{
          id: string;
          task_id: string;
          attempt: number;
        }>(
          `SELECT id, task_id, attempt FROM memory_outbox
           WHERE status IN ('pending', 'failed') AND attempt < 3
             AND next_attempt_at <= ?
           ORDER BY created_at LIMIT 1`,
          now(),
        );
        if (!pending) return undefined;
        this.options.store.run(
          `UPDATE memory_outbox SET status = 'processing',
             attempt = attempt + 1, updated_at = ? WHERE id = ?`,
          now(),
          pending.id,
        );
        return pending;
      });
      if (!row) return false;
      try {
        await this.curate(row.id, row.task_id);
        this.options.store.run(
          `UPDATE memory_outbox SET status = 'succeeded',
             error_message = NULL, updated_at = ? WHERE id = ?`,
          now(),
          row.id,
        );
      } catch (error) {
        const attempts = row.attempt + 1;
        const retryAt = new Date(
          Date.now() + Math.min(60_000, 1_000 * 2 ** attempts),
        ).toISOString();
        this.options.store.run(
          `UPDATE memory_outbox SET status = 'failed', error_message = ?,
             next_attempt_at = ?, updated_at = ? WHERE id = ?`,
          error instanceof Error ? error.message : String(error),
          retryAt,
          now(),
          row.id,
        );
      }
      return true;
    } finally {
      this.running = false;
    }
  }

  private async curate(turnId: string, taskId: string): Promise<void> {
    const task = this.options.store.task(taskId);
    if (!task || task.status !== "succeeded") {
      throw new Error("策展任务不存在或尚未成功");
    }
    const profile = this.options.profiles.get(task.agentProfileId);
    if (!profile) throw new Error("策展任务缺少 AgentProfile");
    if (!profile.memory.enabled) return;
    const driver = this.options.drivers.get(task.agentProfileId);
    if (!driver) throw new Error("策展任务缺少 AgentDriver");
    const context: MemoryContext = {
      agentProfileId: task.agentProfileId,
      principalId: task.principalId,
      conversationSpaceId: task.conversationSpaceId,
      conversationKey: task.conversationKey,
      conversationKind: task.message.conversation.kind,
      sourceMessageIds: [task.message.messageId],
      sourceTaskId: task.id,
      origin: "curated",
      actorIsGroupAdmin: task.message.actor.role === "owner" || task.message.actor.role === "admin",
    };
    const message = textOf(task.message.parts);
    const relevant = message
      ? this.options.memory.renderContext(this.options.memory.search(context, message, 12))
      : [];
    const prompt = curationPrompt(
      task.message.conversation.kind,
      message,
      task.finalText,
      relevant,
    );
    this.options.hostTools.register(turnId, {
      allowedTools: CURATOR_TOOLS,
      memory: context,
    });
    try {
      let completed = false;
      for await (const event of driver.runTurn({
        turnId,
        conversationKey: `memory-curation:${task.id}`,
        profile: {
          ...profile,
          permissions: { maxMode: "deny" },
        },
        prompt,
        parts: [{ type: "text", text: prompt }],
        memoryContext: [],
        developerInstructions: [
          "# IMGent background memory curation",
          this.options.skills.require(CURATION_SKILL).body,
        ].join("\n\n"),
        ephemeral: true,
        hostTools: [...CURATOR_TOOLS],
        builtInTools: "none",
      })) {
        if (event.type === "completed") completed = event.result === "success";
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "approval-request" || event.type === "question") {
          throw new Error("后台策展不得请求审批或用户输入");
        }
      }
      if (!completed) throw new Error("后台策展 turn 未成功完成");
    } finally {
      await this.options.hostTools.unregister(turnId);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

function curationPrompt(
  conversationKind: "direct" | "group",
  message: string,
  finalText: string | undefined,
  relevant: readonly string[],
): string {
  return [
    "执行一次 IMGent 后台记忆策展。不要回复用户。",
    `会话边界：${conversationKind}`,
    `当前用户消息：${JSON.stringify(message)}`,
    `Agent 最终回复：${JSON.stringify(finalText ?? "")}`,
    "当前允许作用域内的相关记忆：",
    ...(relevant.length > 0 ? relevant.map((entry) => `- ${entry}`) : ["- 无"]),
    "仅在信息明确、持久且对未来有用时调用 memory.remember；必要时先调用 memory.search。没有合格内容就不要写入。",
  ].join("\n");
}
