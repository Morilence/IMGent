import WebSocket from "ws";
import { normalizeQqDispatch, QqCompatibilityError } from "./normalize.js";
import {
  GROUP_AND_C2C_INTENT,
  QqOpcode,
  type QqGatewayPayload,
  type QqReadyEvent,
} from "./protocol.js";
import type {
  AdapterReadiness,
  ImAdapter,
  InboundMessage,
  OutboundMessage,
  PlatformCapabilities,
  SendResult,
} from "@agent-pigeon/contracts";

export interface QqCredential {
  appSecret: string;
}

export interface QqAdapterOptions {
  botInstanceId: string;
  appId: string;
  credential: QqCredential;
  apiBaseUrl?: string;
  tokenUrl?: string;
  gatewayUrl?: string;
  fullGroupEventPermission?: boolean;
  resume?: { sessionId: string; sequence: string };
  fetch?: typeof globalThis.fetch;
  websocketFactory?: (url: string) => WebSocket;
  onCompatibilityError?: (
    error: QqCompatibilityError,
    payload: QqGatewayPayload,
    checkpoint?: { key: string; value: string },
  ) => Promise<void>;
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

interface GatewayInfo {
  url: string;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function textParts(message: OutboundMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if ("attachment" in part) {
        return part.attachment.url
          ? `[${part.type}] ${part.attachment.url}`
          : `[${part.type} 无法直接发送]`;
      }
      if (part.type === "card") return part.summary ?? `[card:${part.rawType}]`;
      return `[unknown:${part.rawType}]`;
    })
    .join("\n");
}

export class QqAdapter implements ImAdapter {
  readonly id = "qq" as const;
  readonly capabilities: PlatformCapabilities = {
    conversationKinds: ["direct", "group"],
    groupIngestion: "admin-opt-in-full",
    threads: false,
    inboundTransport: "websocket",
    requiresReplyContext: false,
    supportsProactiveSend: true,
  };

  private readonly fetch: typeof globalThis.fetch;
  private readonly websocketFactory: (url: string) => WebSocket;
  private accessToken?: AccessToken;
  private socket?: WebSocket;
  private stopped = true;
  private abort?: AbortController;
  private sessionId: string | undefined;
  private sequence: number | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatAcknowledged = true;
  private sentKeys = new Map<string, SendResult>();
  private msgSequences = new Map<string, number>();
  private runPromise: Promise<void> | undefined;
  private fullGroupEventPermission: boolean;

  constructor(private readonly options: QqAdapterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.websocketFactory = options.websocketFactory ?? ((url) => new WebSocket(url));
    this.sessionId = options.resume?.sessionId;
    this.sequence = options.resume ? Number(options.resume.sequence) : undefined;
    this.fullGroupEventPermission = options.fullGroupEventPermission ?? false;
  }

  markFullGroupEventPermission(): void {
    this.fullGroupEventPermission = true;
  }

  async checkReady(): Promise<AdapterReadiness> {
    const details: string[] = [];
    if (!this.options.appId) details.push("QQ AppID 缺失");
    if (!this.options.credential.appSecret) details.push("QQ AppSecret 缺失");
    try {
      const token = await this.token();
      const gateway = await this.gateway(token);
      if (!gateway.url.startsWith("wss://") && !gateway.url.startsWith("ws://")) {
        details.push("QQ Gateway 返回了无效 WebSocket URL");
      }
    } catch (error) {
      details.push(`QQ 鉴权或 Gateway 检查失败: ${errorMessage(error)}`);
    }
    if (!this.fullGroupEventPermission) {
      details.push("未验证全量群消息事件权限；full 模式不可用");
    }
    return {
      ready: details.every((detail) => detail.startsWith("未验证")),
      details,
    };
  }

  async start(
    onMessage: (
      message: InboundMessage,
      checkpoint?: { key: string; value: string },
    ) => Promise<void>,
  ): Promise<void> {
    if (this.runPromise) throw new Error("QQ adapter 已启动");
    this.stopped = false;
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
    let attempt = 0;
    while (!signal.aborted) {
      try {
        await this.connectOnce(onMessage, signal);
        attempt = 0;
      } catch (error) {
        if (signal.aborted) break;
        attempt += 1;
        try {
          await delay(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)), signal);
        } catch {
          if (signal.aborted) break;
          throw error;
        }
      }
    }
  }

  private async connectOnce(
    onMessage: (
      message: InboundMessage,
      checkpoint?: { key: string; value: string },
    ) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const token = await this.token();
    const gateway = await this.gateway(token);
    const socket = this.websocketFactory(this.options.gatewayUrl ?? gateway.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => socket.close(1000, "shutdown");
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("error", reject);
      socket.on("message", (data) => {
        void this.handlePayload(
          JSON.parse(data.toString()) as QqGatewayPayload,
          token,
          onMessage,
        ).catch(reject);
      });
      socket.once("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        this.clearHeartbeat();
        if (signal.aborted || code === 1000) resolve();
        else reject(new Error(`QQ Gateway 断开: ${code}`));
      });
    });
  }

  private async handlePayload(
    payload: QqGatewayPayload,
    token: string,
    onMessage: (
      message: InboundMessage,
      checkpoint?: { key: string; value: string },
    ) => Promise<void>,
  ): Promise<void> {
    switch (payload.op) {
      case QqOpcode.HELLO: {
        const interval = Number((payload.d as { heartbeat_interval?: number }).heartbeat_interval);
        if (!Number.isFinite(interval) || interval < 1_000) {
          throw new Error("QQ Gateway Hello 缺少有效 heartbeat_interval");
        }
        this.startHeartbeat(interval);
        if (this.sessionId && this.sequence !== undefined) {
          this.sendGateway({
            op: QqOpcode.RESUME,
            d: {
              token: `QQBot ${token}`,
              session_id: this.sessionId,
              seq: this.sequence,
            },
          });
        } else {
          this.identify(token);
        }
        break;
      }
      case QqOpcode.HEARTBEAT_ACK:
        this.heartbeatAcknowledged = true;
        break;
      case QqOpcode.RECONNECT:
        this.socket?.close(4000, "server reconnect");
        break;
      case QqOpcode.INVALID_SESSION:
        this.sessionId = undefined;
        this.sequence = undefined;
        this.identify(token);
        break;
      case QqOpcode.DISPATCH: {
        if (payload.t === "READY") {
          const ready = payload.d as QqReadyEvent;
          if (!ready.session_id) throw new Error("QQ READY 缺少 session_id");
          this.sessionId = ready.session_id;
        }
        const checkpoint =
          payload.s === undefined || !this.sessionId
            ? undefined
            : {
                key: "gateway_resume",
                value: JSON.stringify({
                  sessionId: this.sessionId,
                  sequence: String(payload.s),
                }),
              };
        try {
          const message = normalizeQqDispatch(
            payload,
            this.options.botInstanceId,
            this.options.appId,
          );
          if (message) {
            await onMessage(message, checkpoint);
          }
        } catch (error) {
          if (error instanceof QqCompatibilityError && this.options.onCompatibilityError) {
            await this.options.onCompatibilityError(error, payload, checkpoint);
          } else {
            throw error;
          }
        }
        if (payload.s !== undefined) this.sequence = payload.s;
        break;
      }
    }
  }

  private identify(token: string): void {
    this.sendGateway({
      op: QqOpcode.IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents: GROUP_AND_C2C_INTENT,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: "agent-pigeon",
          $device: "agent-pigeon",
        },
      },
    });
  }

  private startHeartbeat(interval: number): void {
    this.clearHeartbeat();
    const beat = () => {
      if (!this.heartbeatAcknowledged) {
        this.socket?.terminate();
        return;
      }
      this.heartbeatAcknowledged = false;
      this.sendGateway({ op: QqOpcode.HEARTBEAT, d: this.sequence ?? null });
    };
    beat();
    this.heartbeat = setInterval(beat, interval);
    this.heartbeat.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private sendGateway(payload: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("QQ Gateway 尚未连接");
    }
    this.socket.send(JSON.stringify(payload));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort(new Error("shutdown"));
    this.clearHeartbeat();
    this.socket?.close(1000, "shutdown");
    await this.runPromise;
    this.runPromise = undefined;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const existing = this.sentKeys.get(message.idempotencyKey);
    if (existing) return existing;
    const token = await this.token();
    const context = message.replyContext?.opaque;
    const expiresAt = message.replyContext?.expiresAt;
    const replyValid = !expiresAt || expiresAt > new Date().toISOString();
    const replyMessageId = typeof context?.messageId === "string" ? context.messageId : undefined;
    const key = `${message.conversation.kind}:${message.conversation.platformConversationId}:${replyMessageId ?? "proactive"}`;
    const msgSeq = (this.msgSequences.get(key) ?? Number(context?.initialMsgSeq ?? 0)) + 1;
    const path =
      message.conversation.kind === "direct"
        ? `/v2/users/${encodeURIComponent(message.conversation.platformConversationId)}/messages`
        : `/v2/groups/${encodeURIComponent(message.conversation.platformConversationId)}/messages`;
    const mode = replyValid && replyMessageId ? "reply" : "proactive";
    const maxReplies = Number(
      context?.maxReplies ?? (message.conversation.kind === "direct" ? 4 : 5),
    );
    if (mode === "reply" && msgSeq > maxReplies) {
      throw new Error(`QQ 被动回复次数已达到上限: ${message.conversation.kind} ${maxReplies}`);
    }
    const body = {
      content: textParts(message),
      msg_type: 0,
      msg_seq: msgSeq,
      ...(mode === "reply" ? { msg_id: replyMessageId } : {}),
      ...(typeof context?.eventId === "string" ? { event_id: context.eventId } : {}),
    };
    const response = await this.fetch(`${this.apiBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "X-Union-Appid": this.options.appId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`QQ 发送失败: HTTP ${response.status} ${await safeText(response)}`);
    }
    const resultBody = (await response.json()) as { id?: string };
    const result: SendResult = {
      ...(resultBody.id ? { platformMessageId: String(resultBody.id) } : {}),
      mode,
    };
    this.msgSequences.set(key, msgSeq);
    this.sentKeys.set(message.idempotencyKey, result);
    return result;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - Date.now() > 60_000) {
      return this.accessToken.value;
    }
    const response = await this.fetch(
      this.options.tokenUrl ?? "https://bots.qq.com/app/getAppAccessToken",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: this.options.appId,
          clientSecret: this.options.credential.appSecret,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`QQ AccessToken 获取失败: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number | string;
    };
    if (!body.access_token) throw new Error("QQ AccessToken 响应缺少 access_token");
    const expiresIn = Number(body.expires_in ?? 7_200);
    this.accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + expiresIn * 1_000,
    };
    return body.access_token;
  }

  private async gateway(token: string): Promise<GatewayInfo> {
    if (this.options.gatewayUrl) return { url: this.options.gatewayUrl };
    const response = await this.fetch(`${this.apiBaseUrl()}/gateway/bot`, {
      headers: {
        Authorization: `QQBot ${token}`,
        "X-Union-Appid": this.options.appId,
      },
    });
    if (!response.ok) throw new Error(`QQ Gateway 获取失败: HTTP ${response.status}`);
    const body = (await response.json()) as GatewayInfo;
    if (!body.url) throw new Error("QQ Gateway 响应缺少 URL");
    return body;
  }

  private apiBaseUrl(): string {
    return (this.options.apiBaseUrl ?? "https://api.sgroup.qq.com").replace(/\/$/, "");
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
