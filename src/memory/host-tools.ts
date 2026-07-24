import type { MemoryContext, MemoryKind, MemoryService, RememberInput } from "./service.js";
import type { AgentHostToolCall, AgentHostToolResult, AgentHostToolSpec } from "@imgent/contracts";

export const MEMORY_HOST_TOOLS: AgentHostToolSpec[] = [
  {
    namespace: "memory",
    name: "remember",
    description:
      "Persist a user-approved fact, preference, decision, plan, or episode in the current allowed memory scope. Only report that it was remembered when this tool returns success.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["self", "group", "episode"],
          description:
            "self means the current actor in the current boundary; group means current group shared memory; episode means current conversation episode.",
        },
        kind: {
          type: "string",
          enum: ["fact", "preference", "decision", "plan", "episode"],
        },
        factKey: { type: "string" },
        value: { type: "string" },
        confidence: { type: "number" },
        expiresAt: { type: "string" },
      },
      required: ["target", "kind", "value"],
      additionalProperties: false,
    },
  },
  {
    namespace: "memory",
    name: "search",
    description:
      "Search only the memory scopes allowed for the current principal and conversation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    namespace: "memory",
    name: "update",
    description: "Correct a memory record only when the current principal is allowed to manage it.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string" },
        value: { type: "string" },
      },
      required: ["memoryId", "value"],
      additionalProperties: false,
    },
  },
  {
    namespace: "memory",
    name: "forget",
    description: "Forget a memory record only when the current principal is allowed to manage it.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string" },
      },
      required: ["memoryId"],
      additionalProperties: false,
    },
  },
];

const KINDS = new Set<MemoryKind>(["fact", "preference", "decision", "plan", "episode"]);

export class MemoryHostTools {
  private contexts = new Map<string, MemoryContext>();

  constructor(private readonly memory: MemoryService) {}

  register(turnId: string, context: MemoryContext): void {
    this.contexts.set(turnId, context);
  }

  unregister(turnId: string): void {
    this.contexts.delete(turnId);
  }

  async handle(call: AgentHostToolCall): Promise<AgentHostToolResult> {
    if (call.namespace !== "memory") {
      return { success: false, text: "未知 host tool namespace" };
    }
    const context = this.contexts.get(call.turnId);
    if (!context) {
      return { success: false, text: "当前 turn 的记忆安全上下文不存在" };
    }
    try {
      switch (call.name) {
        case "remember": {
          const target = call.arguments.target;
          const kind = call.arguments.kind;
          const value = call.arguments.value;
          if (
            (target !== "self" && target !== "group" && target !== "episode") ||
            typeof kind !== "string" ||
            !KINDS.has(kind as MemoryKind) ||
            typeof value !== "string"
          ) {
            throw new Error("remember 参数无效");
          }
          const input: RememberInput = {
            target,
            kind: kind as MemoryKind,
            value,
            ...(typeof call.arguments.factKey === "string"
              ? { factKey: call.arguments.factKey }
              : {}),
            ...(typeof call.arguments.confidence === "number"
              ? { confidence: call.arguments.confidence }
              : {}),
            ...(typeof call.arguments.expiresAt === "string"
              ? { expiresAt: call.arguments.expiresAt }
              : {}),
          };
          const record = this.memory.remember(context, input);
          return {
            success: true,
            text: JSON.stringify({
              memoryId: record.id,
              scope: record.scopeType,
              receipt: record.scopeType.startsWith("group_")
                ? `已记入本群记忆：${record.value}`
                : `已记住：${record.value}`,
            }),
          };
        }
        case "search": {
          if (typeof call.arguments.query !== "string") {
            throw new Error("search.query 必须是字符串");
          }
          const records = this.memory.search(
            context,
            call.arguments.query,
            typeof call.arguments.limit === "number" ? call.arguments.limit : undefined,
          );
          return { success: true, text: JSON.stringify(records) };
        }
        case "update": {
          if (
            typeof call.arguments.memoryId !== "string" ||
            typeof call.arguments.value !== "string"
          ) {
            throw new Error("update 参数无效");
          }
          const record = this.memory.update(context, call.arguments.memoryId, call.arguments.value);
          return record
            ? { success: true, text: JSON.stringify(record) }
            : { success: false, text: "记忆不存在或当前会话无权修改" };
        }
        case "forget": {
          if (typeof call.arguments.memoryId !== "string") {
            throw new Error("forget.memoryId 必须是字符串");
          }
          const forgotten = this.memory.forget(context, call.arguments.memoryId);
          return forgotten
            ? { success: true, text: "已从当前允许作用域忘记该记忆" }
            : { success: false, text: "记忆不存在或当前会话无权删除" };
        }
        default:
          return { success: false, text: "未知 memory tool" };
      }
    } catch (error) {
      return {
        success: false,
        text: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
