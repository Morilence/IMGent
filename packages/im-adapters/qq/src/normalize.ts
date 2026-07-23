import type { QqAttachment, QqGatewayPayload, QqMessageEvent } from "./protocol.js";
import type { ActorRole, InboundMessage, MessagePart, Mention } from "@agent-pigeon/contracts";

function role(value: string | undefined): ActorRole {
  switch (value?.toLowerCase()) {
    case "owner":
    case "creator":
      return "owner";
    case "admin":
    case "administrator":
      return "admin";
    case "member":
      return "member";
    default:
      return "unknown";
  }
}

function attachmentPart(attachment: QqAttachment): MessagePart {
  const mime = attachment.content_type?.toLowerCase();
  const ref = {
    ...(attachment.url ? { url: attachment.url } : {}),
    ...(attachment.filename ? { name: attachment.filename } : {}),
    ...(attachment.content_type ? { mimeType: attachment.content_type } : {}),
    ...(attachment.size === undefined ? {} : { size: attachment.size }),
  };
  if (mime?.startsWith("image/")) return { type: "image", attachment: ref };
  if (mime?.startsWith("audio/")) return { type: "audio", attachment: ref };
  if (mime?.startsWith("video/")) return { type: "video", attachment: ref };
  return { type: "file", attachment: ref };
}

function mentionsOf(event: QqMessageEvent): Mention[] {
  return (event.mentions ?? []).flatMap((mention) => {
    const platformUserId = mention.member_openid ?? mention.user_openid ?? mention.id;
    if (!platformUserId) return [];
    return [
      {
        platformUserId: String(platformUserId),
        ...(mention.username ? { displayName: mention.username } : {}),
      },
    ];
  });
}

export class QqCompatibilityError extends Error {
  constructor(
    message: string,
    readonly eventType?: string,
  ) {
    super(message);
    this.name = "QqCompatibilityError";
  }
}

export function normalizeQqDispatch(
  payload: QqGatewayPayload,
  botInstanceId: string,
  platformBotId: string,
  receivedAt = new Date().toISOString(),
): InboundMessage | undefined {
  if (payload.op !== 0) return undefined;
  if (
    payload.t === "READY" ||
    payload.t === "RESUMED" ||
    payload.t === "FRIEND_ADD" ||
    payload.t === "FRIEND_DEL" ||
    payload.t === "GROUP_ADD_ROBOT" ||
    payload.t === "GROUP_DEL_ROBOT" ||
    payload.t === "C2C_MSG_REJECT" ||
    payload.t === "C2C_MSG_RECEIVE" ||
    payload.t === "GROUP_MSG_REJECT" ||
    payload.t === "GROUP_MSG_RECEIVE"
  ) {
    return undefined;
  }
  if (
    payload.t !== "C2C_MESSAGE_CREATE" &&
    payload.t !== "GROUP_AT_MESSAGE_CREATE" &&
    payload.t !== "GROUP_MESSAGE_CREATE"
  ) {
    throw new QqCompatibilityError("不支持的 QQ Gateway 事件", payload.t);
  }
  const event = payload.d as QqMessageEvent;
  const messageId = String(event.id ?? event.msg_id ?? "");
  if (!messageId) throw new QqCompatibilityError("QQ 消息缺少 message ID", payload.t);
  const group = payload.t !== "C2C_MESSAGE_CREATE";
  const conversationId = group
    ? event.group_openid
    : (event.author?.user_openid ?? event.user_openid);
  const platformUserId = group
    ? (event.author?.member_openid ?? event.member?.member_openid)
    : (event.author?.user_openid ?? event.user_openid);
  if (!conversationId || !platformUserId) {
    throw new QqCompatibilityError("QQ 消息缺少稳定会话或发言者 ID", payload.t);
  }
  const parts: MessagePart[] = [];
  if (event.content?.trim()) parts.push({ type: "text", text: event.content });
  parts.push(...(event.attachments ?? []).map(attachmentPart));
  if (parts.length === 0) parts.push({ type: "unknown", rawType: "empty" });
  const sequence = payload.s === undefined ? event.msg_seq : payload.s;
  const groupRole = role(event.member?.role ?? event.author?.role);
  const displayName = event.author?.nickname ?? event.member?.nick ?? event.author?.username;
  const replyMinutes = group ? 5 : 60;
  const command = event.content?.trimStart().startsWith("/pigeon") ?? false;
  const mentionsBot = mentionsOf(event).some((mention) => mention.platformUserId === platformBotId);
  const triggered = !group || payload.t === "GROUP_AT_MESSAGE_CREATE" || command || mentionsBot;
  return {
    ...(payload.id ? { eventId: String(payload.id) } : {}),
    messageId,
    dedupeKey: `${messageId}:${sequence === undefined ? "0" : String(sequence)}`,
    ...(sequence === undefined ? {} : { sequence: String(sequence) }),
    platform: "qq",
    botInstanceId,
    conversation: {
      kind: group ? "group" : "direct",
      platformConversationId: String(conversationId),
    },
    actor: {
      platformUserId: String(platformUserId),
      ...(group ? { platformMemberId: String(platformUserId), role: groupRole } : {}),
      ...(displayName ? { displayName } : {}),
    },
    parts,
    mentions: mentionsOf(event),
    ...(event.message_reference?.message_id
      ? { replyTo: { messageId: String(event.message_reference.message_id) } }
      : {}),
    replyContext: {
      expiresAt: new Date(
        Date.parse(event.timestamp ?? receivedAt) + replyMinutes * 60_000,
      ).toISOString(),
      opaque: {
        messageId,
        eventId: payload.id,
        initialMsgSeq: 0,
        maxReplies: group ? 5 : 4,
      },
    },
    ...(event.timestamp ? { platformSentAt: event.timestamp } : {}),
    receivedAt,
    triggered,
  };
}
