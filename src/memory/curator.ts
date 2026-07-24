import { textOf } from "@imgent/contracts";
import type { MemoryContext, MemoryService } from "./service.js";
import type { IMGentStore } from "../storage/store.js";

function now(): string {
  return new Date().toISOString();
}

function explicitMemory(text: string): string | undefined {
  const match = /(?:请记住|记住|remember(?:\s+that)?)\s*[：:,，]?\s*(.{2,2000})/isu.exec(
    text.trim(),
  );
  return match?.[1]?.trim();
}

export class MemoryCurator {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: IMGentStore,
    private readonly memory: MemoryService,
  ) {}

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
      const row = this.store.transaction(() => {
        const pending = this.store.get<{
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
        this.store.run(
          `UPDATE memory_outbox SET status = 'processing',
             attempt = attempt + 1, updated_at = ? WHERE id = ?`,
          now(),
          pending.id,
        );
        return pending;
      });
      if (!row) return false;
      try {
        const task = this.store.task(row.task_id);
        if (!task || task.status !== "succeeded") {
          throw new Error("策展任务不存在或尚未成功");
        }
        const value = explicitMemory(textOf(task.message.parts));
        if (value) {
          const context: MemoryContext = {
            agentProfileId: task.agentProfileId,
            principalId: task.principalId,
            conversationSpaceId: task.conversationSpaceId,
            conversationKey: task.conversationKey,
            conversationKind: task.message.conversation.kind,
            sourceMessageIds: [task.message.messageId],
            actorIsGroupAdmin:
              task.message.actor.role === "owner" || task.message.actor.role === "admin",
          };
          const duplicate = this.memory
            .search(context, value, 20)
            .some((record) => record.value === value);
          if (!duplicate) {
            this.memory.remember(context, {
              target: task.message.conversation.kind === "group" ? "group" : "self",
              kind: "fact",
              value,
              confidence: 1,
            });
          }
        }
        this.store.run(
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
        this.store.run(
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

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}
