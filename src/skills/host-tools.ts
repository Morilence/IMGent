import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillDefinition, SkillRegistry } from "./registry.js";
import type { AgentHostToolCall, AgentHostToolResult, AgentHostToolSpec } from "@imgent/contracts";

export const SKILL_HOST_TOOLS: AgentHostToolSpec[] = [
  {
    namespace: "skills",
    name: "list",
    description: "List IMGent skills available to the current AgentProfile.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    namespace: "skills",
    name: "load",
    description:
      "Load one IMGent skill selected from the host-provided catalog. Returns trusted local instructions and a temporary resource root. Loading does not approve script execution.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

interface SkillTurnContext {
  visible: ReadonlyMap<string, SkillDefinition>;
  temporaryRoot?: string;
  materialized: Map<string, string>;
}

export class SkillHostTools {
  private readonly contexts = new Map<string, SkillTurnContext>();

  constructor(private readonly registry: SkillRegistry) {}

  register(turnId: string, requested: readonly string[]): void {
    const visible = this.registry.visible(requested);
    this.contexts.set(turnId, {
      visible: new Map(visible.map((skill) => [skill.name, skill])),
      materialized: new Map(),
    });
  }

  async unregister(turnId: string): Promise<void> {
    const context = this.contexts.get(turnId);
    this.contexts.delete(turnId);
    if (context?.temporaryRoot) {
      for (const root of context.materialized.values()) await makeWritable(root);
      await rm(context.temporaryRoot, { recursive: true, force: true });
    }
  }

  async handle(call: AgentHostToolCall): Promise<AgentHostToolResult> {
    if (call.namespace !== "skills") {
      return { success: false, text: "未知 skills host tool namespace" };
    }
    const context = this.contexts.get(call.turnId);
    if (!context) return { success: false, text: "当前 turn 的 skills 上下文不存在" };
    if (call.name === "list") {
      return {
        success: true,
        text: JSON.stringify(
          [...context.visible.values()].map(({ name, description }) => ({ name, description })),
        ),
      };
    }
    if (call.name !== "load") return { success: false, text: "未知 skills tool" };
    const name = call.arguments.name;
    if (typeof name !== "string") return { success: false, text: "skills.load.name 必须是字符串" };
    const definition = context.visible.get(name);
    if (!definition) return { success: false, text: "skill 不存在或未分配给当前 AgentProfile" };
    try {
      const root = await this.materialize(context, definition);
      return {
        success: true,
        text: JSON.stringify({
          name: definition.name,
          description: definition.description,
          instructions: definition.body,
          resourceRoot: root,
          notice: "资源来自本机部署者；执行 scripts 仍受 Agent 权限和审批约束。",
        }),
      };
    } catch (error) {
      return {
        success: false,
        text: `skill 临时物化失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async materialize(
    context: SkillTurnContext,
    definition: SkillDefinition,
  ): Promise<string> {
    const existing = context.materialized.get(definition.name);
    if (existing) return existing;
    context.temporaryRoot ??= await mkdtemp(join(tmpdir(), "imgent-skills-"));
    const destination = join(context.temporaryRoot, definition.name);
    await mkdir(destination, { mode: 0o700 });
    for (const entry of definition.packageEntries) {
      const path = join(destination, entry.path);
      if (entry.type === "directory") {
        await mkdir(path, { recursive: true, mode: 0o700 });
      } else {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, entry.content, {
          mode: entry.executable ? 0o700 : 0o600,
          flag: "wx",
        });
      }
    }
    await makeReadOnly(destination, definition);
    context.materialized.set(definition.name, destination);
    return destination;
  }
}

async function makeReadOnly(root: string, definition: SkillDefinition): Promise<void> {
  for (const entry of definition.packageEntries.toReversed()) {
    await chmod(
      join(root, entry.path),
      entry.type === "directory" ? 0o555 : entry.executable ? 0o555 : 0o444,
    );
  }
  await chmod(root, 0o555);
}

async function makeWritable(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) return;
  if (!metadata.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const entry of await readdir(path)) await makeWritable(join(path, entry));
}
