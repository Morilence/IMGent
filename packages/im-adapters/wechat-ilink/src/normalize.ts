import {
  MessageItemType,
  MessageType,
  type CdnMedia,
  type MessageItem,
  type WechatMessage,
} from "./protocol.js";
import type { AttachmentRef, InboundMessage, MessagePart } from "@agent-pigeon/contracts";

export class WechatCompatibilityError extends Error {
  constructor(
    message: string,
    readonly diagnostic: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WechatCompatibilityError";
  }
}

function mediaRef(media: CdnMedia | undefined, extra: Record<string, unknown>): AttachmentRef {
  return {
    ...(media?.full_url ? { url: media.full_url } : {}),
    opaque: {
      wechat: {
        ...(media ?? {}),
        ...extra,
      },
    },
  };
}

function part(item: MessageItem): MessagePart {
  switch (item.type) {
    case MessageItemType.TEXT:
      return { type: "text", text: item.text_item?.text ?? "" };
    case MessageItemType.IMAGE:
      return {
        type: "image",
        attachment: mediaRef(item.image_item?.media, {
          itemType: "image",
          image: item.image_item,
        }),
      };
    case MessageItemType.VOICE:
      return {
        type: "audio",
        attachment: mediaRef(item.voice_item?.media, {
          itemType: "voice",
          voice: item.voice_item,
        }),
        ...(item.voice_item?.text ? { transcript: item.voice_item.text } : {}),
      };
    case MessageItemType.FILE:
      return {
        type: "file",
        attachment: {
          ...mediaRef(item.file_item?.media, {
            itemType: "file",
            file: item.file_item,
          }),
          ...(item.file_item?.file_name ? { name: item.file_item.file_name } : {}),
          ...(item.file_item?.len ? { size: Number(item.file_item.len) } : {}),
          ...(item.file_item?.md5 ? { checksum: item.file_item.md5 } : {}),
        },
      };
    case MessageItemType.VIDEO:
      return {
        type: "video",
        attachment: mediaRef(item.video_item?.media, {
          itemType: "video",
          video: item.video_item,
        }),
      };
    default:
      return { type: "unknown", rawType: String(item.type ?? "missing") };
  }
}

export function normalizeWechatMessage(
  message: WechatMessage,
  botInstanceId: string,
  receivedAt = new Date().toISOString(),
): InboundMessage | undefined {
  if (message.message_type === MessageType.BOT) return undefined;
  if (message.group_id) {
    throw new WechatCompatibilityError("微信 iLink v1 收到疑似群消息，已拒绝执行", {
      groupIdPresent: true,
      messageId: String(message.message_id ?? ""),
      sequence: String(message.seq ?? ""),
      itemTypes: (message.item_list ?? []).map((item) => item.type ?? null),
    });
  }
  if (!message.from_user_id || message.message_id === undefined) {
    throw new WechatCompatibilityError("微信消息缺少稳定 sender/message ID", {
      hasSender: Boolean(message.from_user_id),
      hasMessageId: message.message_id !== undefined,
      sequence: String(message.seq ?? ""),
    });
  }
  const sequence = String(message.seq ?? "0");
  const messageId = String(message.message_id);
  const parts = (message.item_list ?? []).map(part);
  if (parts.length === 0) parts.push({ type: "unknown", rawType: "empty" });
  const firstReference = (message.item_list ?? []).find(
    (item) => item.ref_msg?.message_item?.msg_id,
  )?.ref_msg?.message_item?.msg_id;
  return {
    messageId,
    dedupeKey: `${sequence}:${messageId}`,
    sequence,
    platform: "wechat-ilink",
    botInstanceId,
    conversation: {
      kind: "direct",
      platformConversationId: message.from_user_id,
    },
    actor: {
      platformUserId: message.from_user_id,
    },
    parts,
    mentions: [],
    ...(firstReference ? { replyTo: { messageId: firstReference } } : {}),
    ...(message.context_token
      ? {
          replyContext: {
            opaque: { contextToken: message.context_token },
          },
        }
      : {}),
    ...(message.create_time_ms
      ? {
          platformSentAt: new Date(Number(message.create_time_ms)).toISOString(),
        }
      : {}),
    receivedAt,
    triggered: true,
  };
}
