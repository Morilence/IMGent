import { MEMORY_HOST_TOOLS } from "../memory/host-tools.js";
import { SKILL_HOST_TOOLS } from "../skills/host-tools.js";
import type { MemoryHostTools } from "../memory/host-tools.js";
import type { MemoryContext } from "../memory/service.js";
import type { SkillHostTools } from "../skills/host-tools.js";
import type { AgentHostToolCall, AgentHostToolResult, AgentHostToolSpec } from "@imgent/contracts";

export const IMGENT_HOST_TOOLS: AgentHostToolSpec[] = [...MEMORY_HOST_TOOLS, ...SKILL_HOST_TOOLS];

export const MEMORY_HOST_TOOL_IDS = MEMORY_HOST_TOOLS.map(hostToolId);
export const SKILL_HOST_TOOL_IDS = SKILL_HOST_TOOLS.map(hostToolId);

export interface HostTurnContext {
  allowedTools: readonly string[];
  memory?: MemoryContext;
  skills?: readonly string[];
}

export class IMGentHostTools {
  private readonly allowed = new Map<string, ReadonlySet<string>>();

  constructor(
    private readonly memory: MemoryHostTools,
    private readonly skills: SkillHostTools,
  ) {}

  register(turnId: string, context: HostTurnContext): void {
    this.allowed.set(turnId, new Set(context.allowedTools));
    if (context.memory) this.memory.register(turnId, context.memory);
    if (context.skills) this.skills.register(turnId, context.skills);
  }

  async unregister(turnId: string): Promise<void> {
    this.allowed.delete(turnId);
    this.memory.unregister(turnId);
    await this.skills.unregister(turnId);
  }

  async handle(call: AgentHostToolCall): Promise<AgentHostToolResult> {
    const allowed = this.allowed.get(call.turnId);
    if (!allowed) return { success: false, text: "当前 turn 的 IMGent host tool 上下文不存在" };
    if (!allowed.has(hostToolId(call))) {
      return { success: false, text: "当前 turn 不允许使用该 IMGent host tool" };
    }
    if (call.namespace === "memory") return this.memory.handle(call);
    if (call.namespace === "skills") return this.skills.handle(call);
    return { success: false, text: "未知 IMGent host tool namespace" };
  }
}

export function hostToolId(tool: Pick<AgentHostToolSpec, "namespace" | "name">): string {
  return `${tool.namespace}.${tool.name}`;
}
