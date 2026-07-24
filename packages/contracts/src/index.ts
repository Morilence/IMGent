export type Platform = "qq" | "wechat-ilink";
export type ConversationKind = "direct" | "group";
export type ActorRole = "owner" | "admin" | "member" | "unknown";

export interface AttachmentRef {
  id?: string;
  url?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  checksum?: string;
  opaque?: Record<string, unknown>;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "image"; attachment: AttachmentRef }
  | { type: "file"; attachment: AttachmentRef }
  | { type: "audio"; attachment: AttachmentRef; transcript?: string }
  | { type: "video"; attachment: AttachmentRef }
  | { type: "card"; summary?: string; rawType: string }
  | { type: "unknown"; rawType: string };

export interface Mention {
  platformUserId: string;
  displayName?: string;
  offset?: number;
  length?: number;
}

export interface ReplyRef {
  messageId: string;
  actorPlatformUserId?: string;
}

export interface ConversationRef {
  kind: ConversationKind;
  platformConversationId: string;
  threadId?: string;
}

export interface ReplyContext {
  expiresAt?: string;
  opaque: Record<string, unknown>;
}

export interface InboundMessage {
  eventId?: string;
  messageId: string;
  dedupeKey: string;
  sequence?: string;
  platform: Platform;
  botInstanceId: string;
  conversation: ConversationRef;
  actor: {
    platformUserId: string;
    platformMemberId?: string;
    role?: ActorRole;
    displayName?: string;
  };
  parts: MessagePart[];
  mentions: Mention[];
  replyTo?: ReplyRef;
  replyContext?: ReplyContext;
  platformSentAt?: string;
  receivedAt: string;
  rawRef?: string;
  triggered?: boolean;
}

export interface OutboundMessage {
  botInstanceId: string;
  conversation: ConversationRef;
  parts: MessagePart[];
  replyTo?: ReplyRef;
  replyContext?: ReplyContext;
  idempotencyKey: string;
}

export interface SendResult {
  platformMessageId?: string;
  mode: "reply" | "proactive";
}

export interface PlatformCapabilities {
  conversationKinds: readonly ConversationKind[];
  groupIngestion: "none" | "triggered" | "admin-opt-in-full";
  threads: boolean;
  inboundTransport: "websocket" | "long-polling" | "webhook";
  requiresReplyContext: boolean;
  supportsProactiveSend: boolean;
}

export interface AdapterReadiness {
  ready: boolean;
  details: string[];
}

export interface ImAdapter {
  readonly id: Platform;
  readonly capabilities: PlatformCapabilities;
  start(
    onMessage: (
      message: InboundMessage,
      checkpoint?: { key: string; value: string },
    ) => Promise<void>,
  ): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<SendResult>;
  checkReady(): Promise<AdapterReadiness>;
}

export type PermissionMode = "deny" | "ask" | "allow";

export interface AgentProfile {
  id: string;
  driver: "codex" | "claude-code";
  command: string;
  workspace: string;
  prompt?: string;
  permissions: {
    maxMode: PermissionMode;
  };
  memory: {
    enabled: boolean;
  };
}

export interface BotInstance {
  id: string;
  adapter: Platform;
  transport?: "websocket";
  platformBotId?: string;
  platformBotIdEnv?: string;
  credentialRef: string;
  authorizingPlatformUserId?: string;
  baseUrl?: string;
  groupIngestionDefault?: "triggered";
  enabled?: boolean;
}

export interface Route {
  botInstanceId: string;
  agentProfileId: string;
}

export interface IMGentConfig {
  version: 1;
  dataDir: string;
  server: {
    host: string;
    port: number;
  };
  allowedWorkspaceRoots?: string[];
  agentProfiles: AgentProfile[];
  bots: BotInstance[];
  routes: Route[];
}

export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  sanitizedInput: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  expiresAt: string;
}

export interface UserQuestion {
  requestId: string;
  prompt: string;
  choices?: string[];
  expiresAt: string;
}

export type AgentRequestAnswer =
  { decision: "allow" | "deny"; remember?: boolean } | { decision: "answer"; value: string };

export type AgentEvent =
  | { type: "output-delta"; text: string }
  | { type: "output-final"; text: string }
  | { type: "approval-request"; request: ApprovalRequest }
  | { type: "question"; request: UserQuestion }
  | { type: "session"; sessionId: string }
  | { type: "completed"; result: "success" | "cancelled" }
  | { type: "error"; code: string; retryable: boolean; message: string };

export interface AgentTurnInput {
  turnId: string;
  conversationKey: string;
  sessionId?: string;
  profile: AgentProfile;
  prompt: string;
  parts: MessagePart[];
  memoryContext: string[];
  signal?: AbortSignal;
}

export interface DriverReadiness {
  ready: boolean;
  version?: string;
  details: string[];
}

export interface AgentDriver {
  readonly id: "codex" | "claude-code";
  checkReady(profile: AgentProfile): Promise<DriverReadiness>;
  runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent>;
  answerRequest(requestId: string, answer: AgentRequestAnswer): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  close?(): Promise<void>;
}

export interface AgentHostToolSpec {
  namespace: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentHostToolCall {
  turnId: string;
  namespace: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentHostToolResult {
  success: boolean;
  text: string;
}

export type AgentHostToolHandler = (call: AgentHostToolCall) => Promise<AgentHostToolResult>;

export function conversationKey(
  agentProfileId: string,
  message: Pick<InboundMessage, "platform" | "botInstanceId" | "conversation">,
): string {
  const segments = [
    agentProfileId,
    message.platform,
    message.botInstanceId,
    message.conversation.kind,
    message.conversation.platformConversationId,
  ];
  if (message.conversation.threadId) {
    segments.push(message.conversation.threadId);
  }
  return segments.map((segment) => encodeURIComponent(segment)).join(":");
}

export function textOf(parts: readonly MessagePart[]): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
          return `[图片${part.attachment.name ? `: ${part.attachment.name}` : ""}]`;
        case "file":
          return `[文件${part.attachment.name ? `: ${part.attachment.name}` : ""}]`;
        case "audio":
          return part.transcript ?? "[语音]";
        case "video":
          return `[视频${part.attachment.name ? `: ${part.attachment.name}` : ""}]`;
        case "card":
          return part.summary ?? `[卡片: ${part.rawType}]`;
        case "unknown":
          return `[不支持的消息类型: ${part.rawType}]`;
      }
    })
    .join("\n")
    .trim();
}
