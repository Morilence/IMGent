import { join } from "node:path";
import { QqAdapter, type QqCredential } from "@agent-pigeon/adapter-qq";
import { WechatIlinkAdapter, type WechatCredential } from "@agent-pigeon/adapter-wechat-ilink";
import { conversationKey, textOf } from "@agent-pigeon/contracts";
import { ClaudeCodeDriver } from "@agent-pigeon/driver-claude-code";
import { CodexDriver } from "@agent-pigeon/driver-codex";
import Fastify, { type FastifyInstance } from "fastify";
import { ApprovalService } from "../approvals/service.js";
import { loadConfig } from "../config/index.js";
import { IdentityService } from "../identity/service.js";
import { MemoryCurator } from "../memory/curator.js";
import { MEMORY_HOST_TOOLS, MemoryHostTools } from "../memory/host-tools.js";
import { MemoryService } from "../memory/service.js";
import { ConversationScheduler } from "../queue/scheduler.js";
import { CredentialStore } from "../security/credential-store.js";
import { PigeonStore } from "../storage/store.js";
import { Logger } from "./logger.js";
import { OutboundDispatcher } from "./outbound.js";
import type {
  AgentDriver,
  AgentPigeonConfig,
  AgentProfile,
  ImAdapter,
  InboundMessage,
  OutboundMessage,
} from "@agent-pigeon/contracts";

const WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";

export interface ReadinessReport {
  ready: boolean;
  details: string[];
  bots: Record<string, { ready: boolean; details: string[] }>;
  profiles: Record<string, { ready: boolean; details: string[] }>;
}

export class AgentPigeonApplication {
  readonly identity: IdentityService;
  readonly memory: MemoryService;
  readonly approvals: ApprovalService;
  readonly outbound: OutboundDispatcher;
  readonly adapters = new Map<string, ImAdapter>();
  readonly drivers = new Map<string, AgentDriver>();
  readonly profiles: ReadonlyMap<string, AgentProfile>;

  private readonly logger = new Logger("application");
  private readonly memoryTools: MemoryHostTools;
  private readonly scheduler: ConversationScheduler;
  private readonly curator: MemoryCurator;
  private readonly routes: ReadonlyMap<string, string>;
  private server: FastifyInstance | undefined;
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private started = false;
  private closed = false;

  private constructor(
    readonly configPath: string,
    readonly config: AgentPigeonConfig,
    readonly store: PigeonStore,
    private readonly credentials: CredentialStore,
  ) {
    this.profiles = new Map(config.agentProfiles.map((profile) => [profile.id, profile]));
    this.routes = new Map(
      config.routes.map((route) => [route.botInstanceId, route.agentProfileId]),
    );
    this.identity = new IdentityService(store);
    this.memory = new MemoryService(store);
    this.approvals = new ApprovalService(store);
    this.outbound = new OutboundDispatcher(store);
    this.memoryTools = new MemoryHostTools(this.memory);
    this.curator = new MemoryCurator(store, this.memory);
    this.scheduler = new ConversationScheduler({
      store,
      profiles: this.profiles,
      drivers: this.drivers,
      adapters: this.adapters,
      approvals: this.approvals,
      memory: this.memory,
      memoryTools: this.memoryTools,
      outbound: this.outbound,
    });
  }

  static async create(configPath: string): Promise<AgentPigeonApplication> {
    const config = await loadConfig(configPath);
    const credentials = new CredentialStore(config.dataDir);
    const store = await PigeonStore.open(
      join(config.dataDir, "agent-pigeon.sqlite"),
      await credentials.secretBox(),
    );
    const application = new AgentPigeonApplication(configPath, config, store, credentials);
    try {
      await application.assemble();
      return application;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  private async assemble(): Promise<void> {
    for (const profile of this.config.agentProfiles) {
      const options = {
        hostTools: MEMORY_HOST_TOOLS,
        hostToolHandler: this.memoryTools.handle.bind(this.memoryTools),
      };
      this.drivers.set(
        profile.id,
        profile.driver === "codex"
          ? new CodexDriver(options)
          : new ClaudeCodeDriver({
              ...options,
              probeOnReady: false,
            }),
      );
    }

    for (const bot of this.config.bots) {
      if (bot.enabled === false) continue;
      if (bot.adapter === "qq") {
        const credential = await this.credentials.get<QqCredential>(bot.credentialRef);
        if (!credential?.appSecret) {
          throw new Error(`QQ BotInstance ${bot.id} 缺少本地 AppSecret 凭据`);
        }
        const appId =
          bot.platformBotId ??
          (bot.platformBotIdEnv ? process.env[bot.platformBotIdEnv] : undefined);
        if (!appId) {
          throw new Error(`QQ BotInstance ${bot.id} 无法解析 AppID`);
        }
        const resume = parseQqResume(this.store.checkpoint(bot.id, "gateway_resume"));
        const fullGroupEventPermission = Boolean(
          this.store.get<{ count: number }>(
            `SELECT count(*) AS count
             FROM group_policies gp
             JOIN conversation_spaces cs
               ON cs.id = gp.conversation_space_id
             WHERE cs.bot_instance_id = ?
               AND gp.platform_full_capability = 1`,
            bot.id,
          )?.count,
        );
        this.adapters.set(
          bot.id,
          new QqAdapter({
            botInstanceId: bot.id,
            appId,
            credential,
            ...(resume ? { resume } : {}),
            fullGroupEventPermission,
            onCompatibilityError: async (error, payload, checkpoint) => {
              this.store.transaction(() => {
                this.store.addDeadLetter(
                  "qq.compatibility",
                  {
                    message: error.message,
                    opcode: payload.op,
                    eventType: error.eventType ?? payload.t,
                  },
                  bot.id,
                );
                if (checkpoint) this.store.setCheckpoint(bot.id, checkpoint);
              });
            },
          }),
        );
      } else {
        const credential = await this.credentials.get<WechatCredential>(bot.credentialRef);
        if (!credential?.botToken || !bot.platformBotId) {
          throw new Error(`微信 BotInstance ${bot.id} 尚未完成 QR 授权或缺少本地凭据`);
        }
        const cursor = this.store.checkpoint(bot.id, "get_updates_buf");
        this.adapters.set(
          bot.id,
          new WechatIlinkAdapter({
            botInstanceId: bot.id,
            platformBotId: bot.platformBotId,
            ...(bot.authorizingPlatformUserId
              ? {
                  authorizingPlatformUserId: bot.authorizingPlatformUserId,
                }
              : {}),
            credential,
            baseUrl: bot.baseUrl ?? WECHAT_BASE_URL,
            ...(cursor ? { cursor } : {}),
            onCompatibilityError: async (error, checkpoint) => {
              this.store.transaction(() => {
                this.store.addDeadLetter(
                  "wechat-ilink.compatibility",
                  {
                    message: error.message,
                    diagnostic: error.diagnostic,
                  },
                  bot.id,
                );
                if (checkpoint) this.store.setCheckpoint(bot.id, checkpoint);
              });
            },
            onSessionInvalid: async (message) => {
              this.store.addDeadLetter("wechat-ilink.session-invalid", { message }, bot.id);
              this.logger.error("wechat.session-invalid", {
                botInstanceId: bot.id,
                message,
              });
            },
            onCheckpoint: async (checkpoint) => {
              this.store.transaction(() => {
                this.store.setCheckpoint(bot.id, checkpoint);
              });
            },
          }),
        );
      }
    }
  }

  async checkReady(): Promise<ReadinessReport> {
    const details: string[] = [];
    const bots: ReadinessReport["bots"] = {};
    const profiles: ReadinessReport["profiles"] = {};
    try {
      this.store.database.prepare("SELECT 1").get();
      this.store.database.exec("CREATE TEMP TABLE IF NOT EXISTS readiness_probe(value INTEGER)");
      this.store.database.exec("DELETE FROM readiness_probe");
    } catch (error) {
      details.push(`SQLite 不可写: ${errorMessage(error)}`);
    }
    await Promise.all(
      [...this.drivers.entries()].map(async ([profileId, driver]) => {
        const profile = this.profiles.get(profileId);
        if (!profile) return;
        const result = await driver.checkReady(profile);
        profiles[profileId] = {
          ready: result.ready,
          details: result.details,
        };
      }),
    );
    await Promise.all(
      [...this.adapters.entries()].map(async ([botId, adapter]) => {
        const result = await adapter.checkReady();
        bots[botId] = result;
      }),
    );
    const readyRoute = this.config.routes.some((route) => {
      const bot = this.config.bots.find((entry) => entry.id === route.botInstanceId);
      return (
        bot?.enabled !== false &&
        bots[route.botInstanceId]?.ready === true &&
        profiles[route.agentProfileId]?.ready === true
      );
    });
    if (!readyRoute) {
      details.push("没有同时 ready 的启用 BotInstance 与 AgentProfile 路由");
    }
    return {
      ready: details.length === 0,
      details,
      bots,
      profiles,
    };
  }

  async start(options: { skipReadiness?: boolean } = {}): Promise<void> {
    if (this.started) throw new Error("Agent Pigeon 已启动");
    if (!options.skipReadiness) {
      const readiness = await this.checkReady();
      if (!readiness.ready) {
        throw new Error(`readiness 失败: ${readiness.details.join("; ")}`);
      }
    }
    this.scheduler.start();
    this.curator.start();
    await this.outbound.drain(this.adapters);
    this.maintenanceTimer = setInterval(() => {
      this.approvals.expirePending();
      this.store.cleanupExpiredRawEvents();
      void this.outbound.drain(this.adapters);
    }, 60_000);
    this.maintenanceTimer.unref();
    for (const [botId, adapter] of this.adapters) {
      await adapter.start(async (message, checkpoint) => {
        await this.handleInbound(message, checkpoint);
      });
      this.logger.info("adapter.started", { botInstanceId: botId });
    }
    this.server = Fastify({ logger: false });
    this.server.get("/healthz", async () => ({
      status: "ok",
      started: this.started,
    }));
    this.server.get("/readyz", async (_request, reply) => {
      const readiness = await this.checkReady();
      if (!readiness.ready) reply.code(503);
      return readiness;
    });
    await this.server.listen(this.config.server);
    this.started = true;
    this.logger.info("application.started", {
      host: this.config.server.host,
      port: this.config.server.port,
      bots: this.adapters.size,
      profiles: this.drivers.size,
    });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.stop()));
    await this.scheduler.stop();
    await this.curator.stop();
    await Promise.allSettled([...this.drivers.values()].map((driver) => driver.close?.()));
    await this.server?.close();
    this.server = undefined;
    this.store.close();
  }

  async handleInbound(
    message: InboundMessage,
    checkpoint?: { key: string; value: string },
  ): Promise<void> {
    const profileId = this.routes.get(message.botInstanceId);
    if (!profileId) {
      this.store.addDeadLetter(
        "routing.missing",
        { platform: message.platform },
        message.botInstanceId,
        message.messageId,
      );
      return;
    }
    const key = conversationKey(profileId, message);
    if (
      message.platform === "qq" &&
      message.conversation.kind === "group" &&
      message.triggered === false
    ) {
      const adapter = this.adapters.get(message.botInstanceId);
      if (adapter instanceof QqAdapter) {
        adapter.markFullGroupEventPermission();
      }
      const group = this.store.get<{
        id: string;
        mode: "triggered" | "full";
      }>(
        `SELECT cs.id, gp.mode FROM conversation_spaces cs
         JOIN group_policies gp ON gp.conversation_space_id = cs.id
         WHERE cs.agent_profile_id = ? AND cs.platform = 'qq'
           AND cs.bot_instance_id = ? AND cs.kind = 'group'
           AND cs.platform_conversation_id = ?`,
        profileId,
        message.botInstanceId,
        message.conversation.platformConversationId,
      );
      if (group) {
        this.identity.setPlatformFullCapability(group.id, true);
      }
      if (group?.mode !== "full") {
        if (checkpoint) {
          this.store.transaction(() => {
            this.store.setCheckpoint(message.botInstanceId, checkpoint);
          });
        }
        return;
      }
    }
    const command = parseCommand(textOf(message.parts));
    const directPaired =
      message.conversation.kind === "direct" &&
      this.store.get<{ paired: number }>(
        `SELECT paired FROM platform_identities
         WHERE agent_profile_id = ? AND platform = ? AND bot_instance_id = ?
           AND platform_user_id = ?`,
        profileId,
        message.platform,
        message.botInstanceId,
        message.actor.platformUserId,
      )?.paired === 1;
    const groupAuthorized =
      message.conversation.kind === "group" &&
      Boolean(
        this.store.get<{ id: string }>(
          `SELECT cs.id FROM conversation_spaces cs
           JOIN group_authorizations ga ON ga.conversation_space_id = cs.id
           WHERE cs.agent_profile_id = ? AND cs.platform = ?
             AND cs.bot_instance_id = ? AND cs.kind = 'group'
             AND cs.platform_conversation_id = ?`,
          profileId,
          message.platform,
          message.botInstanceId,
          message.conversation.platformConversationId,
        ),
      );
    const shouldEnqueue =
      !command && message.triggered !== false && (directPaired || groupAuthorized);
    const ingested = this.store.ingest(message, profileId, key, checkpoint, shouldEnqueue);
    if (ingested.duplicate) return;

    if (message.conversation.kind === "direct") {
      if (
        !this.identity.isPaired(ingested.platformIdentityId) &&
        command?.name !== "bind-consume"
      ) {
        const code = this.identity.createPairingCode(ingested.platformIdentityId);
        await this.immediateReply(
          message,
          [
            "此身份尚未配对，当前不会运行 Agent。",
            `请部署者在本机执行：agent-pigeon pair ${code}`,
            "配对码 10 分钟内有效且只能使用一次。",
          ].join("\n"),
          `pairing:${ingested.eventId}`,
        );
        return;
      }
    } else if (!this.identity.isGroupAuthorized(ingested.conversationSpaceId)) {
      if (message.triggered !== false) {
        await this.immediateReply(
          message,
          `本群尚未授权。部署者可使用群空间 ID ${ingested.conversationSpaceId} 完成授权。`,
          `group-unauthorized:${ingested.eventId}`,
        );
      }
      return;
    }

    if (command) {
      await this.handleCommand(
        command,
        message,
        key,
        ingested.principalId,
        ingested.platformIdentityId,
        ingested.conversationSpaceId,
        ingested.eventId,
      );
      return;
    }
    const taskId = ingested.taskId;
    if (!taskId) return;
    const waiting =
      this.store.get<{ count: number }>(
        `SELECT count(*) AS count FROM tasks
       WHERE conversation_key = ? AND id <> ?
         AND status IN ('queued', 'active', 'waiting_approval')`,
        key,
        taskId,
      )?.count ?? 0;
    if (waiting > 0) {
      await this.immediateReply(
        message,
        `已排队，前面还有 ${waiting} 个任务。发送“取消”可停止当前任务。`,
        `queued:${taskId}`,
      );
    }
  }

  private async handleCommand(
    command: PigeonCommand,
    message: InboundMessage,
    key: string,
    principalId: string,
    platformIdentityId: string,
    conversationSpaceId: string,
    eventId: string,
  ): Promise<void> {
    let response: string;
    try {
      switch (command.name) {
        case "cancel": {
          const result = await this.scheduler.cancelConversation(key, principalId);
          response = `已取消：运行中 ${result.active} 个，排队中 ${result.queued} 个。`;
          break;
        }
        case "allow":
        case "deny": {
          await this.scheduler.answerRequest(
            command.requestId,
            principalId,
            { decision: command.name },
            key,
          );
          response = command.name === "allow" ? "已允许该请求。" : "已拒绝该请求。";
          break;
        }
        case "answer": {
          await this.scheduler.answerRequest(
            command.requestId,
            principalId,
            { decision: "answer", value: command.value },
            key,
          );
          response = "已提交回答。";
          break;
        }
        case "bind-create": {
          if (message.conversation.kind !== "direct") {
            throw new Error("绑定码只能在私聊中创建");
          }
          const code = this.identity.createBindingCode(platformIdentityId);
          response = `绑定码：${code}\n请在另一个已经配对的私聊身份中发送 /pigeon bind ${code}`;
          break;
        }
        case "bind-consume": {
          this.identity.consumeBindingCode(command.code, platformIdentityId);
          response = "两个平台身份已绑定到同一 Principal；Agent session 仍保持分离。";
          break;
        }
        case "group-mode": {
          if (message.conversation.kind !== "group") {
            throw new Error("群采集模式只能在 QQ 群内切换");
          }
          if (!this.identity.isPaired(platformIdentityId)) {
            throw new Error("发起者尚未配对");
          }
          this.identity.changeGroupMode(
            conversationSpaceId,
            principalId,
            message.actor.role ?? "unknown",
            command.mode,
          );
          response =
            command.mode === "full"
              ? "已开启本群全量采集：普通消息仅用于本群上下文，原文默认保留 7 天；发送 /pigeon group triggered 可关闭。"
              : "已恢复 triggered 模式：新的普通群消息不再持久化，只有触发消息会运行 Agent。";
          break;
        }
        case "help":
          response = [
            "/pigeon cancel",
            "/pigeon bind [绑定码]",
            "/pigeon allow <requestId>",
            "/pigeon deny <requestId>",
            "/pigeon answer <requestId> <内容>",
            "/pigeon group full|triggered",
          ].join("\n");
          break;
      }
    } catch (error) {
      response = `操作失败：${errorMessage(error)}`;
    }
    await this.immediateReply(message, response, `command:${eventId}`);
  }

  private async immediateReply(
    inbound: InboundMessage,
    text: string,
    idempotencyKey: string,
  ): Promise<void> {
    const adapter = this.adapters.get(inbound.botInstanceId);
    if (!adapter) throw new Error("BotInstance adapter 不存在");
    const outbound: OutboundMessage = {
      botInstanceId: inbound.botInstanceId,
      conversation: inbound.conversation,
      parts: [{ type: "text", text }],
      replyTo: { messageId: inbound.messageId },
      ...(inbound.replyContext ? { replyContext: inbound.replyContext } : {}),
      idempotencyKey,
    };
    await this.outbound.send(adapter, outbound);
  }
}

type PigeonCommand =
  | { name: "cancel" }
  | { name: "allow" | "deny"; requestId: string }
  | { name: "answer"; requestId: string; value: string }
  | { name: "bind-create" }
  | { name: "bind-consume"; code: string }
  | { name: "group-mode"; mode: "triggered" | "full" }
  | { name: "help" };

function parseCommand(text: string): PigeonCommand | undefined {
  const normalized = text.trim();
  if (normalized === "取消") return { name: "cancel" };
  if (!normalized.startsWith("/pigeon")) return undefined;
  const parts = normalized.split(/\s+/u);
  const action = parts[1]?.toLowerCase();
  if (!action || action === "help") return { name: "help" };
  if (action === "cancel") return { name: "cancel" };
  if ((action === "allow" || action === "deny") && parts[2]) {
    return { name: action, requestId: parts[2] };
  }
  if (action === "answer" && parts[2] && parts.length >= 4) {
    return {
      name: "answer",
      requestId: parts[2],
      value: parts.slice(3).join(" "),
    };
  }
  if (action === "bind") {
    return parts[2] ? { name: "bind-consume", code: parts[2] } : { name: "bind-create" };
  }
  if (action === "group" && (parts[2] === "full" || parts[2] === "triggered")) {
    return { name: "group-mode", mode: parts[2] };
  }
  return { name: "help" };
}

function parseQqResume(
  value: string | undefined,
): { sessionId: string; sequence: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.sessionId === "string" && typeof parsed.sequence === "string"
      ? { sessionId: parsed.sessionId, sequence: parsed.sequence }
      : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
