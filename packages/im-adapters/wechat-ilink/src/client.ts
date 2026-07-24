import { randomBytes, randomUUID } from "node:crypto";
import { IMGentError, normalizeError } from "@imgent/contracts";
import {
  attachmentToWechatItem,
  materializeWechatInboundMedia,
  type WechatHttpClient,
} from "./media.js";
import { normalizeWechatMessage, WechatCompatibilityError } from "./normalize.js";
import {
  MessageType,
  type GetUpdatesResponse,
  type MessageItem,
  type WechatMessage,
} from "./protocol.js";
import type {
  AdapterReadiness,
  ErrorDescriptor,
  ImAdapter,
  InboundMessage,
  OutboundMessage,
  PlatformCapabilities,
  SendResult,
} from "@imgent/contracts";

export interface WechatCredential {
  botToken: string;
}

export interface WechatIlinkAdapterOptions {
  botInstanceId: string;
  platformBotId: string;
  authorizingPlatformUserId?: string;
  credential: WechatCredential;
  baseUrl: string;
  cursor?: string;
  cdnBaseUrl?: string;
  mediaDirectory?: string;
  fetch?: typeof globalThis.fetch;
  onCompatibilityError?: (
    error: WechatCompatibilityError,
    checkpoint?: { key: string; value: string },
  ) => Promise<void>;
  onSessionInvalid?: (message: string) => Promise<void>;
  onCheckpoint?: (checkpoint: { key: string; value: string }) => Promise<void>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function uin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");
}

export class WechatIlinkAdapter implements ImAdapter, WechatHttpClient {
  readonly id = "wechat-ilink" as const;
  readonly capabilities: PlatformCapabilities = {
    conversationKinds: ["direct"],
    groupIngestion: "none",
    threads: false,
    inboundTransport: "long-polling",
    requiresReplyContext: true,
    supportsProactiveSend: false,
  };

  readonly fetch: typeof globalThis.fetch;
  private cursor: string;
  private abort?: AbortController;
  private runPromise: Promise<void> | undefined;
  private sentKeys = new Map<string, SendResult>();
  private blockedIssue: ErrorDescriptor | undefined;

  constructor(private readonly options: WechatIlinkAdapterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.cursor = options.cursor ?? "";
  }

  async checkReady(): Promise<AdapterReadiness> {
    const issues: ErrorDescriptor[] = [];
    if (
      !this.options.platformBotId ||
      !this.options.authorizingPlatformUserId ||
      !this.options.credential.botToken
    ) {
      issues.push(new IMGentError("ADAPTER_AUTH_REQUIRED").descriptor);
    }
    if (this.blockedIssue) issues.push(this.blockedIssue);
    try {
      await this.post(
        "ilink/bot/getconfig",
        {
          ilink_user_id: this.options.authorizingPlatformUserId,
        },
        10_000,
      );
    } catch (error) {
      issues.push(normalizeError(error, "ADAPTER_CONNECTION_FAILED").descriptor);
    }
    return { ready: issues.length === 0, issues };
  }

  async start(
    onMessage: (
      message: InboundMessage,
      checkpoint?: { key: string; value: string },
    ) => Promise<void>,
  ): Promise<void> {
    if (this.runPromise) throw new Error("微信 adapter 已启动");
    this.abort = new AbortController();
    this.runPromise = this.run(onMessage, this.abort.signal);
    await Promise.resolve();
  }

  private async run(
    onMessage: (
      message: InboundMessage,
      checkpoint?: { key: string; value: string },
    ) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let timeoutMs = 35_000;
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const response = await this.post<GetUpdatesResponse>(
          "ilink/bot/getupdates",
          { get_updates_buf: this.cursor },
          timeoutMs + 5_000,
          signal,
        );
        if (response.errcode === -14) {
          const invalidSession = new IMGentError("ADAPTER_SESSION_INVALID", {
            diagnostic: { platform: "wechat-ilink", errcode: response.errcode },
          });
          this.blockedIssue = invalidSession.descriptor;
          await this.options.onSessionInvalid?.(
            response.errmsg ?? "微信 iLink session 已失效，请重新扫码授权",
          );
          throw invalidSession;
        }
        if (response.ret && response.ret !== 0) {
          throw new IMGentError("ADAPTER_REQUEST_REJECTED", {
            diagnostic: {
              platform: "wechat-ilink",
              operation: "getupdates",
              ret: response.ret,
              errcode: response.errcode,
            },
          });
        }
        timeoutMs = Math.max(5_000, Math.min(response.longpolling_timeout_ms ?? 35_000, 120_000));
        const messages = response.msgs ?? [];
        for (const [index, raw] of messages.entries()) {
          const final = index === messages.length - 1;
          const checkpoint =
            final && response.get_updates_buf !== undefined
              ? { key: "get_updates_buf", value: response.get_updates_buf }
              : undefined;
          try {
            const normalized = normalizeWechatMessage(raw, this.options.botInstanceId);
            let message = normalized;
            if (normalized && normalized.parts.some((part) => "attachment" in part)) {
              if (!this.options.mediaDirectory) {
                throw new WechatCompatibilityError("微信媒体目录未配置", {
                  messageId: normalized.messageId,
                });
              }
              try {
                message = await materializeWechatInboundMedia(
                  this,
                  normalized,
                  this.options.mediaDirectory,
                  this.options.cdnBaseUrl,
                );
              } catch (error) {
                throw new WechatCompatibilityError("微信媒体下载、解密或校验失败", {
                  messageId: normalized.messageId,
                  reason: error instanceof Error ? error.message : String(error),
                });
              }
            }
            if (message) await onMessage(message, checkpoint);
            else if (checkpoint) {
              await this.options.onCheckpoint?.(checkpoint);
              this.cursor = checkpoint.value;
            }
          } catch (error) {
            if (error instanceof WechatCompatibilityError && this.options.onCompatibilityError) {
              await this.options.onCompatibilityError(error, checkpoint);
            } else {
              throw error;
            }
          }
          if (checkpoint) this.cursor = checkpoint.value;
        }
        if (messages.length === 0 && response.get_updates_buf !== undefined) {
          const checkpoint = {
            key: "get_updates_buf",
            value: response.get_updates_buf,
          };
          await this.options.onCheckpoint?.(checkpoint);
          this.cursor = checkpoint.value;
        }
        attempt = 0;
      } catch (error) {
        if (signal.aborted) return;
        const normalized = normalizeError(error, "ADAPTER_CONNECTION_FAILED");
        if (normalized.descriptor.retry.strategy !== "backoff") {
          this.blockedIssue = normalized.descriptor;
          return;
        }
        attempt += 1;
        try {
          await delay(
            normalized.descriptor.retry.retryAfterMs ??
              Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)),
            signal,
          );
        } catch {
          if (signal.aborted) return;
          throw error;
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.abort?.abort(new Error("shutdown"));
    await this.runPromise;
    this.runPromise = undefined;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const existing = this.sentKeys.get(message.idempotencyKey);
    if (existing) return existing;
    const contextToken = message.replyContext?.opaque.contextToken;
    if (typeof contextToken !== "string" || !contextToken) {
      throw new IMGentError("ADAPTER_REPLY_CONTEXT_INVALID", {
        diagnostic: { platform: "wechat-ilink", reason: "missing context token" },
      });
    }
    if (
      message.replyContext?.expiresAt &&
      message.replyContext.expiresAt <= new Date().toISOString()
    ) {
      throw new IMGentError("ADAPTER_REPLY_CONTEXT_INVALID", {
        diagnostic: { platform: "wechat-ilink", reason: "expired context" },
      });
    }
    const items: MessageItem[] = [];
    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.text) items.push({ type: 1, text_item: { text: part.text } });
      } else if (
        part.type === "image" ||
        part.type === "video" ||
        part.type === "file" ||
        part.type === "audio"
      ) {
        items.push(
          await attachmentToWechatItem(
            this,
            part.attachment,
            part.type,
            message.conversation.platformConversationId,
            this.options.cdnBaseUrl,
          ),
        );
      } else if (part.type === "card") {
        items.push({
          type: 1,
          text_item: { text: part.summary ?? `[不支持的卡片: ${part.rawType}]` },
        });
      } else {
        items.push({
          type: 1,
          text_item: { text: `[不支持的消息类型: ${part.rawType}]` },
        });
      }
    }
    if (items.length === 0) {
      throw new IMGentError("ADAPTER_REQUEST_REJECTED", {
        diagnostic: { platform: "wechat-ilink", reason: "empty outbound message" },
      });
    }
    const clientId = `imgent-${randomUUID()}`;
    const raw: WechatMessage = {
      from_user_id: "",
      to_user_id: message.conversation.platformConversationId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: 2,
      item_list: items,
      context_token: contextToken,
    };
    await this.post("ilink/bot/sendmessage", { msg: raw });
    const result: SendResult = { platformMessageId: clientId, mode: "reply" };
    this.sentKeys.set(message.idempotencyKey, result);
    return result;
  }

  async post<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new IMGentError("ADAPTER_REQUEST_TIMEOUT")),
      timeoutMs,
    );
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetch(
        `${this.options.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            AuthorizationType: "ilink_bot_token",
            Authorization: `Bearer ${this.options.credential.botToken}`,
            "X-WECHAT-UIN": uin(),
            "iLink-App-ClientVersion": "65536",
          },
          body: JSON.stringify({
            ...body,
            base_info: {
              channel_version: "0.1.0",
              bot_agent: "IMGent/0.1.0",
            },
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw platformHttpError(response, path);
      }
      const result = (await response.json()) as T & { ret?: number; errmsg?: string };
      if (path.endsWith("sendmessage") && result.ret && result.ret !== 0) {
        throw new IMGentError("ADAPTER_REQUEST_REJECTED", {
          diagnostic: {
            platform: "wechat-ilink",
            operation: "sendmessage",
            ret: result.ret,
          },
        });
      }
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function platformHttpError(response: Response, operation: string): IMGentError {
  const diagnostic = { platform: "wechat-ilink", operation, status: response.status };
  if (response.status === 401) return new IMGentError("ADAPTER_AUTH_REQUIRED", { diagnostic });
  if (response.status === 403) return new IMGentError("ADAPTER_PERMISSION_DENIED", { diagnostic });
  if (response.status === 429) {
    const value = response.headers.get("retry-after");
    const seconds = value ? Number(value) : Number.NaN;
    const date = value ? Date.parse(value) : Number.NaN;
    const retryAfterMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1_000)
      : Number.isFinite(date)
        ? Math.max(0, date - Date.now())
        : undefined;
    return new IMGentError("ADAPTER_RATE_LIMITED", {
      ...(retryAfterMs === undefined ? {} : { retryAfterMs: Math.min(300_000, retryAfterMs) }),
      diagnostic,
    });
  }
  if (response.status === 408) {
    return new IMGentError("ADAPTER_REQUEST_TIMEOUT", { diagnostic });
  }
  if (response.status >= 500) {
    return new IMGentError("ADAPTER_SERVICE_UNAVAILABLE", { diagnostic });
  }
  return new IMGentError("ADAPTER_REQUEST_REJECTED", { diagnostic });
}
