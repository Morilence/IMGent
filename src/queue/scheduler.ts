import { textOf } from "@imgent/contracts";
import { Logger } from "../runtime/logger.js";
import type { ApprovalService } from "../approvals/service.js";
import type { MemoryHostTools } from "../memory/host-tools.js";
import type { MemoryContext, MemoryService } from "../memory/service.js";
import type { OutboundDispatcher } from "../runtime/outbound.js";
import type { IMGentStore, StoredTask } from "../storage/store.js";
import type {
  AgentDriver,
  AgentProfile,
  AgentRequestAnswer,
  ImAdapter,
  OutboundMessage,
} from "@imgent/contracts";

export interface SchedulerOptions {
  store: IMGentStore;
  profiles: ReadonlyMap<string, AgentProfile>;
  drivers: ReadonlyMap<string, AgentDriver>;
  adapters: ReadonlyMap<string, ImAdapter>;
  approvals: ApprovalService;
  memory: MemoryService;
  memoryTools: MemoryHostTools;
  outbound: OutboundDispatcher;
  maxConcurrency?: number;
  logger?: Logger;
}

export class ConversationScheduler {
  private readonly maxConcurrency: number;
  private readonly logger: Logger;
  private running = new Map<string, Promise<void>>();
  private taskDrivers = new Map<string, AgentDriver>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;

  constructor(private readonly options: SchedulerOptions) {
    this.maxConcurrency = options.maxConcurrency ?? 8;
    this.logger = options.logger ?? new Logger("scheduler");
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.store.recoverAfterRestart();
    this.timer = setInterval(() => this.pump(), 100);
    this.timer.unref();
    this.pump();
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.running.size < this.maxConcurrency) {
      const task = this.options.store.claimNextTask();
      if (!task) break;
      const promise = this.execute(task)
        .catch((error) => {
          this.logger.error("task.unhandled", {
            taskId: task.id,
            errorCode: "UNHANDLED_TASK_ERROR",
            message: errorMessage(error),
          });
        })
        .finally(() => {
          this.running.delete(task.id);
          this.taskDrivers.delete(task.id);
          this.options.memoryTools.unregister(task.id);
          queueMicrotask(() => this.pump());
        });
      this.running.set(task.id, promise);
    }
  }

  private async execute(task: StoredTask): Promise<void> {
    const profile = this.options.profiles.get(task.agentProfileId);
    const driver = this.options.drivers.get(task.agentProfileId);
    if (!profile || !driver) {
      this.options.store.transitionTask(task.id, ["active"], "dead_letter", {
        errorCode: "PROFILE_OR_DRIVER_MISSING",
        errorMessage: "AgentProfile 或 AgentDriver 不存在",
      });
      return;
    }
    this.taskDrivers.set(task.id, driver);
    const memoryContext = this.memoryContext(task);
    if (profile.memory.enabled) {
      this.options.memoryTools.register(task.id, memoryContext);
    }
    let memories: string[] = [];
    if (profile.memory.enabled) {
      const query = textOf(task.message.parts);
      if (query) {
        memories = this.options.memory.renderContext(
          this.options.memory.search(memoryContext, query),
        );
      }
    }
    const existingSession = this.options.store.session(task.conversationKey);
    if (
      existingSession &&
      (existingSession.driver !== profile.driver || existingSession.workspace !== profile.workspace)
    ) {
      this.options.store.transitionTask(task.id, ["active"], "failed", {
        errorCode: "SESSION_WORKSPACE_MISMATCH",
        errorMessage: "Agent session 的 driver 或工作目录不匹配",
      });
      await this.reply(
        task,
        "会话工作目录或驱动已变化，请由部署者重置该会话。",
        "session-mismatch",
      );
      return;
    }

    let streamed = "";
    let finalText = "";
    let completed = false;
    try {
      for await (const event of driver.runTurn({
        turnId: task.id,
        conversationKey: task.conversationKey,
        ...(existingSession ? { sessionId: existingSession.sessionId } : {}),
        profile,
        prompt: textOf(task.message.parts),
        parts: task.message.parts,
        memoryContext: memories,
      })) {
        switch (event.type) {
          case "session":
            this.options.store.saveSession(
              task.conversationKey,
              profile.id,
              profile.driver,
              event.sessionId,
              profile.workspace,
            );
            break;
          case "output-delta":
            streamed += event.text;
            break;
          case "output-final":
            finalText = event.text;
            break;
          case "approval-request":
            this.options.approvals.create(
              task.id,
              profile.id,
              task.conversationKey,
              task.principalId,
              event.request,
            );
            await this.reply(
              task,
              [
                `需要审批：${event.request.toolName}`,
                `风险：${event.request.risk}`,
                `请求：${JSON.stringify(event.request.sanitizedInput)}`,
                `允许：/imgent allow ${event.request.requestId}`,
                `拒绝：/imgent deny ${event.request.requestId}`,
              ].join("\n"),
              `approval:${event.request.requestId}`,
            );
            break;
          case "question":
            this.options.approvals.create(
              task.id,
              profile.id,
              task.conversationKey,
              task.principalId,
              {
                requestId: event.request.requestId,
                toolName: "user-question",
                sanitizedInput: {
                  prompt: event.request.prompt,
                  choices: event.request.choices ?? [],
                },
                risk: "low",
                expiresAt: event.request.expiresAt,
              },
            );
            await this.reply(
              task,
              [
                event.request.prompt,
                ...(event.request.choices?.map((choice) => `- ${choice}`) ?? []),
                `回答：/imgent answer ${event.request.requestId} <内容>`,
              ].join("\n"),
              `question:${event.request.requestId}`,
            );
            break;
          case "completed":
            completed = event.result === "success";
            if (event.result === "cancelled") {
              this.options.store.transitionTask(
                task.id,
                ["active", "waiting_approval"],
                "cancelled",
              );
            }
            break;
          case "error":
            this.options.store.transitionTask(task.id, ["active", "waiting_approval"], "failed", {
              errorCode: event.code,
              errorMessage: event.message,
            });
            await this.reply(task, `任务失败：${event.message}`, `error:${event.code}`);
            return;
        }
      }
      if (!completed) return;
      const answer = finalText || streamed || "任务已完成。";
      await this.reply(task, answer, "final");
      this.options.store.completeTask(task.id, answer, profile.memory.enabled);
    } catch (error) {
      await driver.interrupt(task.id).catch(() => undefined);
      this.options.store.transitionTask(task.id, ["active", "waiting_approval"], "failed", {
        errorCode: "TASK_EXECUTION_FAILED",
        errorMessage: errorMessage(error),
      });
      throw error;
    }
  }

  async answerRequest(
    requestId: string,
    principalId: string,
    answer: AgentRequestAnswer,
    conversationKey?: string,
  ): Promise<void> {
    const decision = this.options.approvals.decide(requestId, principalId, answer, conversationKey);
    if (!decision.changed || decision.status === "expired") return;
    const task = this.options.store.task(decision.taskId);
    if (!task) throw new Error("审批对应任务不存在");
    if (answer.decision === "allow") {
      this.options.store.markDangerousSideEffect(task.id);
    }
    const driver = this.taskDrivers.get(task.id) ?? this.options.drivers.get(task.agentProfileId);
    if (!driver) throw new Error("审批对应 AgentDriver 不存在");
    await driver.answerRequest(requestId, answer);
  }

  async cancelConversation(
    conversationKey: string,
    principalId: string,
  ): Promise<{ active: number; queued: number }> {
    const cancelled = this.options.store.cancelConversation(conversationKey, principalId);
    await Promise.all(
      cancelled.activeTurnIds.map(async (turnId) => {
        const task = this.options.store.task(turnId);
        const driver =
          this.taskDrivers.get(turnId) ??
          (task ? this.options.drivers.get(task.agentProfileId) : undefined);
        await driver?.interrupt(turnId);
      }),
    );
    return {
      active: cancelled.activeTurnIds.length,
      queued: cancelled.cancelledQueued,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.running.values());
  }

  private memoryContext(task: StoredTask): MemoryContext {
    return {
      agentProfileId: task.agentProfileId,
      principalId: task.principalId,
      conversationSpaceId: task.conversationSpaceId,
      conversationKey: task.conversationKey,
      conversationKind: task.message.conversation.kind,
      sourceMessageIds: [task.message.messageId],
      actorIsGroupAdmin: task.message.actor.role === "owner" || task.message.actor.role === "admin",
    };
  }

  private async reply(task: StoredTask, text: string, suffix: string): Promise<void> {
    const adapter = this.options.adapters.get(task.message.botInstanceId);
    if (!adapter) throw new Error("BotInstance adapter 不存在");
    const message: OutboundMessage = {
      botInstanceId: task.message.botInstanceId,
      conversation: task.message.conversation,
      parts: [{ type: "text", text }],
      replyTo: { messageId: task.message.messageId },
      ...(task.message.replyContext ? { replyContext: task.message.replyContext } : {}),
      idempotencyKey: `${task.id}:${suffix}`,
    };
    await this.options.outbound.send(adapter, message, task.id);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
