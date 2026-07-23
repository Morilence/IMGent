import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "必须是稳定的本地标识");

export const agentProfileSchema = z
  .object({
    id,
    driver: z.enum(["codex", "claude-code"]),
    command: z.string().min(1),
    workspace: z.string().min(1),
    prompt: z.string().max(20_000).optional(),
    permissions: z
      .object({
        maxMode: z.enum(["deny", "ask", "allow"]).default("ask"),
      })
      .strict()
      .default({ maxMode: "ask" }),
    memory: z
      .object({
        enabled: z.boolean().default(true),
      })
      .strict()
      .default({ enabled: true }),
  })
  .strict();

const qqBotSchema = z
  .object({
    id,
    adapter: z.literal("qq"),
    transport: z.literal("websocket").default("websocket"),
    platformBotId: z.string().min(1).optional(),
    platformBotIdEnv: z.string().min(1).optional(),
    credentialRef: id,
    groupIngestionDefault: z.literal("triggered").default("triggered"),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.platformBotId && !value.platformBotIdEnv) {
      context.addIssue({
        code: "custom",
        message: "QQ BotInstance 必须提供 platformBotId 或 platformBotIdEnv",
      });
    }
  });

const wechatBotSchema = z
  .object({
    id,
    adapter: z.literal("wechat-ilink"),
    credentialRef: id,
    platformBotId: z.string().min(1).optional(),
    authorizingPlatformUserId: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export const botSchema = z.discriminatedUnion("adapter", [qqBotSchema, wechatBotSchema]);

export const configSchema = z
  .object({
    version: z.literal(1),
    dataDir: z.string().min(1).default("./data"),
    server: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65_535).default(8787),
      })
      .strict()
      .default({ host: "127.0.0.1", port: 8787 }),
    allowedWorkspaceRoots: z.array(z.string().min(1)).min(1).optional(),
    agentProfiles: z.array(agentProfileSchema).default([]),
    bots: z.array(botSchema).default([]),
    routes: z
      .array(
        z
          .object({
            botInstanceId: id,
            agentProfileId: id,
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const duplicate = (values: string[]): string | undefined => {
      const seen = new Set<string>();
      return values.find((entry) => {
        if (seen.has(entry)) return true;
        seen.add(entry);
        return false;
      });
    };
    const duplicateProfile = duplicate(value.agentProfiles.map((profile) => profile.id));
    const duplicateBot = duplicate(value.bots.map((bot) => bot.id));
    if (duplicateProfile) {
      context.addIssue({
        code: "custom",
        path: ["agentProfiles"],
        message: `AgentProfile ID 重复: ${duplicateProfile}`,
      });
    }
    if (duplicateBot) {
      context.addIssue({
        code: "custom",
        path: ["bots"],
        message: `BotInstance ID 重复: ${duplicateBot}`,
      });
    }

    const profileIds = new Set(value.agentProfiles.map((profile) => profile.id));
    const botIds = new Set(value.bots.map((bot) => bot.id));
    const routed = new Set<string>();
    for (const [index, route] of value.routes.entries()) {
      if (!botIds.has(route.botInstanceId)) {
        context.addIssue({
          code: "custom",
          path: ["routes", index, "botInstanceId"],
          message: "引用了不存在的 BotInstance",
        });
      }
      if (!profileIds.has(route.agentProfileId)) {
        context.addIssue({
          code: "custom",
          path: ["routes", index, "agentProfileId"],
          message: "引用了不存在的 AgentProfile",
        });
      }
      if (routed.has(route.botInstanceId)) {
        context.addIssue({
          code: "custom",
          path: ["routes", index, "botInstanceId"],
          message: "一个 BotInstance 只能路由到一个 AgentProfile",
        });
      }
      routed.add(route.botInstanceId);
    }
    for (const bot of value.bots) {
      if (!routed.has(bot.id)) {
        context.addIssue({
          code: "custom",
          path: ["routes"],
          message: `BotInstance ${bot.id} 缺少路由`,
        });
      }
    }
  });

export type ParsedConfig = z.infer<typeof configSchema>;
