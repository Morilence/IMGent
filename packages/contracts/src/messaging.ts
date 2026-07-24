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
