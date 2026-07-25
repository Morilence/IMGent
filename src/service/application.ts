import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { QqAdapter, type QqCredential } from "@imgent/adapter-qq";
import { WechatIlinkAdapter, type WechatCredential } from "@imgent/adapter-wechat-ilink";
import { conversationKey, IMGentError, normalizeError, textOf } from "@imgent/contracts";
import { ClaudeCodeDriver } from "@imgent/driver-claude-code";
import { CodexDriver } from "@imgent/driver-codex";
import { ApprovalService } from "../approvals/service.js";
import { loadConfig } from "../config/index.js";
import { renderError, renderErrorText } from "../i18n/index.js";
import { IdentityService } from "../identity/service.js";
import { MemoryCurator } from "../memory/curator.js";
import { MemoryHostTools } from "../memory/host-tools.js";
import { MemoryService } from "../memory/service.js";
import { ConversationScheduler } from "../queue/scheduler.js";
import { IMGENT_HOST_TOOLS, IMGentHostTools } from "../runtime/host-tools.js";
import { Logger } from "../runtime/logger.js";
import { OutboundDispatcher } from "../runtime/outbound.js";
import { SchedulePlanner, ScheduleService } from "../schedule/service.js";
import { CredentialStore } from "../security/credential-store.js";
import { SkillHostTools } from "../skills/host-tools.js";
import { builtInSkillsDirectory } from "../skills/paths.js";
import { SkillRegistry } from "../skills/registry.js";
import {
  cleanupExpiredRawEvents,
  clearLocalMediaPaths,
  referencedMediaPaths,
  releasableMediaEvents,
} from "../storage/media.js";
import { IMGentStore } from "../storage/store.js";
import { collectReadiness, type ReadinessReport } from "./readiness.js";
import type {
  AgentDriver,
  ErrorDescriptor,
  IMGentConfig,
  AgentProfile,
  ImAdapter,
  InboundMessage,
  OutboundMessage,
  SupportedLocale,
} from "@imgent/contracts";

const WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";

export type { ReadinessReport } from "./readiness.js";

export class IMGentApplication {
  readonly identity: IdentityService;
  readonly memory: MemoryService;
  readonly approvals: ApprovalService;
  readonly outbound: OutboundDispatcher;
  readonly adapters = new Map<string, ImAdapter>();
  readonly drivers = new Map<string, AgentDriver>();
  readonly profiles: ReadonlyMap<string, AgentProfile>;
  readonly skills: SkillRegistry;
  readonly schedules: ScheduleService;

  private readonly logger = new Logger("application");
  private readonly hostTools: IMGentHostTools;
  private readonly scheduler: ConversationScheduler;
  private readonly curator: MemoryCurator;
  private readonly schedulePlanner: SchedulePlanner;
  private readonly routes: ReadonlyMap<string, string>;
  private readonly botAssemblyIssues = new Map<string, ErrorDescriptor[]>();
  private readonly adapterStartIssues = new Map<string, ErrorDescriptor[]>();
  private readinessValue: ReadinessReport = {
    ready: false,
    checkedAt: new Date(0).toISOString(),
    depth: "runtime",
    issues: [],
    bots: {},
    profiles: {},
  };
  private readinessRefresh:
    { depth: "runtime" | "diagnostic"; promise: Promise<ReadinessReport> } | undefined;
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private mediaCleanupRunning = false;
  private phase: "created" | "running" | "closed" = "created";

  private constructor(
    readonly configPath: string,
    readonly config: IMGentConfig,
    readonly store: IMGentStore,
    skills: SkillRegistry,
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
    this.schedules = new ScheduleService(
      store,
      this.adapters,
      new Set(this.profiles.keys()),
      this.routes,
    );
    this.schedulePlanner = new SchedulePlanner(this.schedules);
    this.skills = skills;
    this.hostTools = new IMGentHostTools(
      new MemoryHostTools(this.memory),
      new SkillHostTools(this.skills),
    );
    this.curator = new MemoryCurator({
      store,
      memory: this.memory,
      profiles: this.profiles,
      drivers: this.drivers,
      hostTools: this.hostTools,
      skills: this.skills,
    });
    this.scheduler = new ConversationScheduler({
      store,
      profiles: this.profiles,
      drivers: this.drivers,
      adapters: this.adapters,
      approvals: this.approvals,
      memory: this.memory,
      hostTools: this.hostTools,
      skills: this.skills,
      outbound: this.outbound,
      localeFor: (principalId, botInstanceId) => this.localeFor(principalId, botInstanceId),
    });
  }

  static async create(configPath: string): Promise<IMGentApplication> {
    const config = await loadConfig(configPath);
    const credentials = new CredentialStore(config.dataDir);
    const store = await IMGentStore.open(
      join(config.dataDir, "imgent.sqlite"),
      await credentials.secretBox(),
    );
    try {
      const skills = await SkillRegistry.load(
        await builtInSkillsDirectory(),
        join(config.dataDir, "skills"),
      );
      const application = new IMGentApplication(configPath, config, store, skills, credentials);
      await application.assemble();
      return application;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  private async assemble(): Promise<void> {
    for (const profile of this.config.agentProfiles) {
      this.skills.visible(profile.skills);
      const options = {
        hostTools: IMGENT_HOST_TOOLS,
        hostToolHandler: this.hostTools.handle.bind(this.hostTools),
      };
      this.drivers.set(
        profile.id,
        profile.driver === "codex" ? new CodexDriver(options) : new ClaudeCodeDriver(options),
      );
    }

    for (const bot of this.config.bots) {
      if (bot.enabled === false) continue;
      if (bot.adapter === "qq") {
        const credential = await this.credentials.get<QqCredential>(bot.credentialRef);
        if (!credential?.appSecret) {
          this.botAssemblyIssues.set(bot.id, [
            new IMGentError("ADAPTER_AUTH_REQUIRED", {
              diagnostic: { botInstanceId: bot.id, credential: "appSecret" },
            }).descriptor,
          ]);
          continue;
        }
        const appId =
          bot.platformBotId ??
          (bot.platformBotIdEnv ? process.env[bot.platformBotIdEnv] : undefined);
        if (!appId) {
          this.botAssemblyIssues.set(bot.id, [
            new IMGentError("ADAPTER_AUTH_REQUIRED", {
              diagnostic: { botInstanceId: bot.id, setting: "platformBotId" },
            }).descriptor,
          ]);
          continue;
        }
        const resume = parseQqResume(this.store.checkpoint(bot.id, "gateway_resume"));
        const fullGroupPolicy = this.store.get<{
          required: number;
          available: number;
        }>(
          `SELECT
             COALESCE(sum(CASE WHEN gp.mode = 'full' THEN 1 ELSE 0 END), 0) AS required,
             COALESCE(max(gp.platform_full_capability), 0) AS available
             FROM group_policies gp
             JOIN conversation_spaces cs
               ON cs.id = gp.conversation_space_id
             WHERE cs.bot_instance_id = ?`,
          bot.id,
        );
        const fullGroupEventPermissionRequired = Boolean(fullGroupPolicy?.required);
        const fullGroupEventPermission =
          !fullGroupEventPermissionRequired || fullGroupPolicy?.available === 1;
        this.adapters.set(
          bot.id,
          new QqAdapter({
            botInstanceId: bot.id,
            appId,
            credential,
            ...(resume ? { resume } : {}),
            fullGroupEventPermission,
            fullGroupEventPermissionRequired,
            isBotMessageId: (messageId) =>
              Boolean(
                this.store.get<{ id: string }>(
                  `SELECT id FROM outbound_messages
                   WHERE bot_instance_id = ? AND platform_message_id = ?
                     AND status = 'sent'
                   LIMIT 1`,
                  bot.id,
                  messageId,
                ),
              ),
            onCompatibilityError: async (error, payload, checkpoint) => {
              this.store.transaction(() => {
                this.store.addDeadLetter(
                  "qq.compatibility",
                  new IMGentError("ADAPTER_COMPATIBILITY_ERROR"),
                  {
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
          this.botAssemblyIssues.set(bot.id, [
            new IMGentError("ADAPTER_AUTH_REQUIRED", {
              diagnostic: { botInstanceId: bot.id, credential: "wechat authorization" },
            }).descriptor,
          ]);
          continue;
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
            mediaDirectory: join(this.config.dataDir, "media", "wechat-ilink", bot.id),
            ...(cursor ? { cursor } : {}),
            onCompatibilityError: async (error, checkpoint) => {
              this.store.transaction(() => {
                this.store.addDeadLetter(
                  "wechat-ilink.compatibility",
                  new IMGentError("ADAPTER_COMPATIBILITY_ERROR"),
                  {
                    diagnostic: error.diagnostic,
                  },
                  bot.id,
                );
                if (checkpoint) this.store.setCheckpoint(bot.id, checkpoint);
              });
            },
            onSessionInvalid: async (message) => {
              const error = new IMGentError("ADAPTER_SESSION_INVALID", {
                diagnostic: { platform: "wechat-ilink", vendorMessage: message },
              });
              this.store.addDeadLetter("wechat-ilink.session-invalid", error, {}, bot.id);
              this.logger.errorFrom("wechat.session-invalid", error, {
                botInstanceId: bot.id,
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

  readiness(): ReadinessReport {
    return this.readinessValue;
  }

  async refreshReadiness(depth: "runtime" | "diagnostic" = "runtime"): Promise<ReadinessReport> {
    const current = this.readinessRefresh;
    if (current) {
      if (current.depth === "diagnostic" || depth === "runtime") return current.promise;
      await current.promise;
    }
    const promise = this.checkReady(depth).finally(() => {
      if (this.readinessRefresh?.promise === promise) this.readinessRefresh = undefined;
    });
    this.readinessRefresh = { depth, promise };
    return promise;
  }

  private async checkReady(depth: "runtime" | "diagnostic"): Promise<ReadinessReport> {
    const report = await collectReadiness(
      {
        config: this.config,
        store: this.store,
        profiles: this.profiles,
        drivers: this.drivers,
        adapters: this.adapters,
        botAssemblyIssues: this.botAssemblyIssues,
        adapterStartIssues: this.adapterStartIssues,
      },
      depth,
    );
    this.readinessValue = report;
    return report;
  }

  async start(_options: { skipReadiness?: boolean } = {}): Promise<void> {
    if (this.phase !== "created") throw new Error("IMGent 不能重复启动");
    this.scheduler.start();
    this.curator.start();
    await this.cleanupReleasedMedia();
    await this.outbound.drain(this.adapters);
    this.maintenanceTimer = setInterval(() => {
      this.approvals.expirePending();
      cleanupExpiredRawEvents(this.store);
      void this.cleanupReleasedMedia();
      void this.outbound.drain(this.adapters).catch((error: unknown) => {
        this.logger.errorFrom("outbound.drain-failed", error);
      });
      void this.refreshReadiness("runtime").catch((error: unknown) => {
        this.logger.errorFrom("readiness.refresh-failed", error);
      });
    }, 60_000);
    this.maintenanceTimer.unref();
    for (const [botId, adapter] of this.adapters) {
      try {
        await adapter.start(async (message, checkpoint) => {
          await this.handleInbound(message, checkpoint);
        });
        this.logger.info("adapter.started", { botInstanceId: botId });
      } catch (error) {
        this.adapterStartIssues.set(botId, [
          normalizeError(error, "ADAPTER_CONNECTION_FAILED").descriptor,
        ]);
        this.logger.errorFrom("adapter.start-failed", error, { botInstanceId: botId });
      }
    }
    this.schedulePlanner.start();
    this.phase = "running";
    this.logger.info("application.started", {
      bots: this.adapters.size,
      profiles: this.drivers.size,
    });
  }

  async stop(): Promise<void> {
    if (this.phase === "closed") return;
    this.phase = "closed";
    const failures: unknown[] = [];
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    this.schedulePlanner.stop();
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.stop()));
    try {
      await this.scheduler.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.curator.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.cleanupReleasedMedia();
    } catch (error) {
      failures.push(error);
    }
    await Promise.allSettled([...this.drivers.values()].map((driver) => driver.close?.()));
    try {
      this.store.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw failures[0];
  }

  async handleInbound(
    message: InboundMessage,
    checkpoint?: { key: string; value: string },
  ): Promise<void> {
    const profileId = this.routes.get(message.botInstanceId);
    if (!profileId) {
      this.store.addDeadLetter(
        "routing.missing",
        new IMGentError("PROFILE_OR_DRIVER_MISSING"),
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
    const command = parseIMGentCommand(textOf(message.parts));
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
        command?.name !== "bind-consume" &&
        command?.name !== "language"
      ) {
        const code = this.identity.createPairingCode(ingested.platformIdentityId);
        await this.immediateReply(
          message,
          [
            "此身份尚未配对，当前不会运行 Agent。",
            `请部署者在本机执行：imgent pair ${code}`,
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
         AND status IN ('queued', 'active', 'retry_wait', 'waiting_approval')`,
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
    command: IMGentCommand,
    message: InboundMessage,
    key: string,
    principalId: string,
    platformIdentityId: string,
    conversationSpaceId: string,
    eventId: string,
  ): Promise<void> {
    let response: string;
    let responseLocale = this.localeFor(principalId, message.botInstanceId);
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
          response = `绑定码：${code}\n请在另一个私聊身份中发送 /imgent bind ${code}；提交即确认绑定。`;
          break;
        }
        case "bind-consume": {
          this.identity.consumeBindingCode(command.code, platformIdentityId);
          response = "两个平台身份已绑定到同一 Principal；Agent session 仍保持分离。";
          break;
        }
        case "unbind": {
          if (message.conversation.kind !== "direct") {
            throw new Error("解绑只能在私聊中执行");
          }
          this.identity.unbindPlatformIdentity(platformIdentityId);
          response =
            "当前平台身份已解除跨平台绑定；后续记忆不再跨身份召回。历史合并记忆保留在原 Principal，不会自动复制或拆分。";
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
              ? "已开启本群全量采集：普通消息仅用于本群上下文，原文默认保留 7 天；发送 /imgent group triggered 可关闭。"
              : "已恢复 triggered 模式：新的普通群消息不再持久化，只有触发消息会运行 Agent。";
          break;
        }
        case "language": {
          if (command.locale !== "zh-CN" && command.locale !== "en-US") {
            throw new IMGentError("LANGUAGE_UNSUPPORTED");
          }
          this.identity.setLocale(principalId, command.locale);
          responseLocale = command.locale;
          response =
            command.locale === "zh-CN"
              ? "错误与诊断信息将使用简体中文。"
              : "Errors and diagnostics will use English.";
          break;
        }
        case "help":
          response = [
            "/imgent cancel",
            "/imgent bind [绑定码]",
            "/imgent unbind",
            "/imgent allow <requestId>",
            "/imgent deny <requestId>",
            "/imgent answer <requestId> <内容>",
            "/imgent group full|triggered",
            "/imgent language zh-CN|en-US",
          ].join("\n");
          break;
      }
    } catch (error) {
      response = renderErrorText(
        normalizeError(error, "IDENTITY_OPERATION_REJECTED").descriptor,
        responseLocale,
      );
    }
    await this.immediateReply(message, response, `command:${eventId}`);
  }

  private async immediateReply(
    inbound: InboundMessage,
    text: string,
    idempotencyKey: string,
  ): Promise<void> {
    const outbound: OutboundMessage = {
      botInstanceId: inbound.botInstanceId,
      conversation: inbound.conversation,
      parts: [{ type: "text", text }],
      replyTo: { messageId: inbound.messageId },
      ...(inbound.replyContext ? { replyContext: inbound.replyContext } : {}),
      idempotencyKey,
    };
    this.outbound.enqueue(outbound);
    void this.outbound.drain(this.adapters);
  }

  private localeFor(principalId: string, botInstanceId: string): SupportedLocale {
    return (
      this.identity.locale(principalId) ??
      this.config.bots.find((bot) => bot.id === botInstanceId)?.locale ??
      this.config.defaultLocale
    );
  }

  private async cleanupReleasedMedia(): Promise<void> {
    if (this.mediaCleanupRunning) return;
    this.mediaCleanupRunning = true;
    const mediaRoot = resolve(this.config.dataDir, "media", "wechat-ilink");
    try {
      for (const event of releasableMediaEvents(this.store)) {
        let removed = true;
        for (const path of event.paths) {
          const candidate = resolve(path);
          if (candidate !== mediaRoot && !candidate.startsWith(`${mediaRoot}${sep}`)) {
            removed = false;
            this.logger.warn("media.cleanup-path-rejected", {
              eventId: event.eventId,
            });
            continue;
          }
          try {
            await rm(candidate, { force: true });
          } catch (error) {
            removed = false;
            this.logger.errorFrom("media.cleanup-failed", error, {
              eventId: event.eventId,
            });
          }
        }
        if (removed) clearLocalMediaPaths(this.store, event.eventId);
      }
      await this.cleanupOrphanedMedia(
        mediaRoot,
        new Set(referencedMediaPaths(this.store).map((path) => resolve(path))),
      );
    } finally {
      this.mediaCleanupRunning = false;
    }
  }

  private async cleanupOrphanedMedia(
    directory: string,
    referencedPaths: ReadonlySet<string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.cleanupOrphanedMedia(path, referencedPaths);
      } else if (entry.isFile() && !referencedPaths.has(resolve(path))) {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs >= 60 * 60_000) {
          await rm(path, { force: true });
        }
      }
    }
  }
}

export type IMGentCommand =
  | { name: "cancel" }
  | { name: "allow" | "deny"; requestId: string }
  | { name: "answer"; requestId: string; value: string }
  | { name: "bind-create" }
  | { name: "bind-consume"; code: string }
  | { name: "unbind" }
  | { name: "group-mode"; mode: "triggered" | "full" }
  | { name: "language"; locale: string }
  | { name: "help" };

export function parseIMGentCommand(text: string): IMGentCommand | undefined {
  const normalized = text.trim();
  if (normalized === "取消") return { name: "cancel" };
  if (normalized !== "/imgent" && !normalized.startsWith("/imgent ")) return undefined;
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
  if (action === "unbind") return { name: "unbind" };
  if (action === "group" && (parts[2] === "full" || parts[2] === "triggered")) {
    return { name: "group-mode", mode: parts[2] };
  }
  if (action === "language") {
    return { name: "language", locale: parts[2] ?? "" };
  }
  return { name: "help" };
}

export function renderReadiness(report: ReadinessReport, locale: SupportedLocale): unknown {
  const renderComponent = (component: {
    ready: boolean;
    version?: string;
    issues: ErrorDescriptor[];
  }) => ({
    ready: component.ready,
    ...(component.version ? { version: component.version } : {}),
    issues: component.issues.map((issue) => renderError(issue, locale)),
  });
  return {
    ready: report.ready,
    checkedAt: report.checkedAt,
    depth: report.depth,
    locale,
    issues: report.issues.map((issue) => renderError(issue, locale)),
    bots: Object.fromEntries(
      Object.entries(report.bots).map(([id, component]) => [id, renderComponent(component)]),
    ),
    profiles: Object.fromEntries(
      Object.entries(report.profiles).map(([id, component]) => [id, renderComponent(component)]),
    ),
  };
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
