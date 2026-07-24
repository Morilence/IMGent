import type { InboundMessage, MessagePart } from "./messaging.js";

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
