import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { CdnMedia, MessageItem } from "./protocol.js";
import type { AttachmentRef } from "@agent-pigeon/contracts";

export interface WechatHttpClient {
  post<T>(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  fetch: typeof globalThis.fetch;
}

function encrypt(data: Uint8Array, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function mediaType(type: "image" | "video" | "file" | "audio"): number {
  switch (type) {
    case "image":
      return 1;
    case "video":
      return 2;
    case "file":
      return 3;
    case "audio":
      return 4;
  }
}

export async function attachmentToWechatItem(
  client: WechatHttpClient,
  attachment: AttachmentRef,
  type: "image" | "video" | "file" | "audio",
  toUserId: string,
  cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c",
): Promise<MessageItem> {
  const native = attachment.opaque?.wechat as
    | { itemType?: string; image?: unknown; video?: unknown; file?: unknown; voice?: unknown }
    | undefined;
  if (native?.itemType === type) {
    if (type === "image" && native.image) {
      return { type: 2, image_item: native.image as NonNullable<MessageItem["image_item"]> };
    }
    if (type === "video" && native.video) {
      return { type: 5, video_item: native.video as NonNullable<MessageItem["video_item"]> };
    }
    if (type === "file" && native.file) {
      return { type: 4, file_item: native.file as NonNullable<MessageItem["file_item"]> };
    }
    if (type === "audio" && native.voice) {
      return { type: 3, voice_item: native.voice as NonNullable<MessageItem["voice_item"]> };
    }
  }
  if (!attachment.url) throw new Error(`微信 ${type} 发送缺少可访问 URL`);
  const source = await client.fetch(attachment.url);
  if (!source.ok) throw new Error(`媒体下载失败: HTTP ${source.status}`);
  const plaintext = Buffer.from(await source.arrayBuffer());
  const key = randomBytes(16);
  const ciphertext = encrypt(plaintext, key);
  const filekey = randomBytes(16).toString("hex");
  const upload = await client.post<{
    upload_param?: string;
    upload_full_url?: string;
  }>("ilink/bot/getuploadurl", {
    filekey,
    media_type: mediaType(type),
    to_user_id: toUserId,
    rawsize: plaintext.byteLength,
    rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
    filesize: ciphertext.byteLength,
    no_need_thumb: true,
    aeskey: key.toString("hex"),
  });
  const uploadUrl =
    upload.upload_full_url ??
    (upload.upload_param
      ? `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : undefined);
  if (!uploadUrl) throw new Error("微信 getuploadurl 未返回上传参数");
  const uploaded = await client.fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!uploaded.ok) throw new Error(`微信 CDN 上传失败: HTTP ${uploaded.status}`);
  const download = uploaded.headers.get("x-encrypted-param");
  if (!download) throw new Error("微信 CDN 响应缺少 x-encrypted-param");
  const media: CdnMedia = {
    encrypt_query_param: download,
    aes_key: key.toString("base64"),
    encrypt_type: 1,
  };
  if (type === "image") {
    return { type: 2, image_item: { media, mid_size: ciphertext.byteLength } };
  }
  if (type === "video") {
    return { type: 5, video_item: { media, video_size: ciphertext.byteLength } };
  }
  if (type === "audio") {
    return { type: 3, voice_item: { media } };
  }
  return {
    type: 4,
    file_item: {
      media,
      file_name: attachment.name ?? "attachment",
      len: String(plaintext.byteLength),
    },
  };
}
