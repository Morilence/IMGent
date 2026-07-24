import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { CdnMedia, MessageItem } from "./protocol.js";
import type { AttachmentRef, InboundMessage, MessagePart } from "@imgent/contracts";

const DEFAULT_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export interface WechatHttpClient {
  post<T>(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  fetch: typeof globalThis.fetch;
}

function encrypt(data: Uint8Array, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function decrypt(data: Uint8Array, key: Buffer): Buffer {
  if (data.byteLength === 0 || data.byteLength % 16 !== 0) {
    throw new Error("微信 CDN 密文长度不是 AES block 的整数倍");
  }
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function parseAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 16) return decoded;
  if (decoded.byteLength === 32 && /^[0-9a-f]{32}$/iu.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  if (/^[0-9a-f]{32}$/iu.test(value)) return Buffer.from(value, "hex");
  throw new Error("微信媒体 AES key 不是 16 字节");
}

function mediaUrl(media: CdnMedia, cdnBaseUrl: string): string {
  if (media.full_url) return media.full_url;
  if (!media.encrypt_query_param) throw new Error("微信媒体缺少 CDN 下载参数");
  return `${cdnBaseUrl.replace(/\/$/u, "")}/download?encrypted_query_param=${encodeURIComponent(
    media.encrypt_query_param,
  )}`;
}

function extension(type: MessagePart["type"], name?: string, mimeType?: string): string {
  const named = name ? extname(name).slice(0, 12) : "";
  if (/^\.[a-z0-9]{1,11}$/iu.test(named)) return named.toLowerCase();
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "video/mp4") return ".mp4";
  if (mimeType === "audio/silk") return ".silk";
  return type === "file" ? ".bin" : "";
}

function detectedMime(type: MessagePart["type"], data: Buffer, name?: string): string {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  const firstSix = data.subarray(0, 6).toString("ascii");
  if (firstSix === "GIF87a" || firstSix === "GIF89a") return "image/gif";
  if (
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  const suffix = name ? extname(name).toLowerCase() : "";
  if (suffix === ".pdf") return "application/pdf";
  if (suffix === ".txt" || suffix === ".md" || suffix === ".csv") return "text/plain";
  if (suffix === ".json") return "application/json";
  if (type === "audio") return "audio/silk";
  if (type === "video") return "video/mp4";
  return "application/octet-stream";
}

interface NativeWechatAttachment {
  itemType?: "image" | "voice" | "file" | "video";
  image?: NonNullable<MessageItem["image_item"]>;
  voice?: NonNullable<MessageItem["voice_item"]>;
  file?: NonNullable<MessageItem["file_item"]>;
  video?: NonNullable<MessageItem["video_item"]>;
}

function nativeMedia(native: NativeWechatAttachment): {
  media: CdnMedia;
  key?: string;
  expectedPlainSize?: number;
  expectedCipherSize?: number;
  expectedMd5?: string;
  name?: string;
} {
  if (native.itemType === "image" && native.image?.media) {
    return {
      media: native.image.media,
      ...(native.image.aeskey
        ? { key: Buffer.from(native.image.aeskey, "hex").toString("base64") }
        : native.image.media.aes_key
          ? { key: native.image.media.aes_key }
          : {}),
      ...(native.image.mid_size ? { expectedCipherSize: native.image.mid_size } : {}),
    };
  }
  if (native.itemType === "voice" && native.voice?.media) {
    return {
      media: native.voice.media,
      ...(native.voice.media.aes_key ? { key: native.voice.media.aes_key } : {}),
    };
  }
  if (native.itemType === "file" && native.file?.media) {
    const size = native.file.len === undefined ? Number.NaN : Number(native.file.len);
    return {
      media: native.file.media,
      ...(native.file.media.aes_key ? { key: native.file.media.aes_key } : {}),
      ...(Number.isFinite(size) ? { expectedPlainSize: size } : {}),
      ...(native.file.md5 ? { expectedMd5: native.file.md5 } : {}),
      ...(native.file.file_name ? { name: native.file.file_name } : {}),
    };
  }
  if (native.itemType === "video" && native.video?.media) {
    return {
      media: native.video.media,
      ...(native.video.media.aes_key ? { key: native.video.media.aes_key } : {}),
      ...(native.video.video_size ? { expectedCipherSize: native.video.video_size } : {}),
      ...(native.video.video_md5 ? { expectedMd5: native.video.video_md5 } : {}),
    };
  }
  throw new Error("微信媒体元数据不完整");
}

async function fetchMedia(
  client: WechatHttpClient,
  url: string,
  maxBytes: number,
): Promise<Buffer> {
  const response = await client.fetch(url);
  if (!response.ok) throw new Error(`微信 CDN 下载失败: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`微信媒体超过 ${maxBytes} 字节限制`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength > maxBytes) throw new Error(`微信媒体超过 ${maxBytes} 字节限制`);
  return data;
}

async function saveInboundMedia(
  directory: string,
  messageId: string,
  index: number,
  data: Buffer,
  suffix: string,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const messageHash = createHash("sha256").update(messageId).digest("hex").slice(0, 12);
  const contentHash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  const path = join(directory, `${messageHash}-${index}-${contentHash}-${randomUUID()}${suffix}`);
  await writeFile(path, data, { mode: 0o600, flag: "wx" });
  const info = await stat(path);
  if (!info.isFile() || info.size !== data.byteLength) {
    throw new Error("微信媒体临时文件写入后校验失败");
  }
  return path;
}

export async function materializeWechatInboundMedia(
  client: WechatHttpClient,
  message: InboundMessage,
  directory: string,
  cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c",
  maxBytes = DEFAULT_MAX_MEDIA_BYTES,
): Promise<InboundMessage> {
  const materialized = structuredClone(message);
  for (const [index, part] of materialized.parts.entries()) {
    if (!("attachment" in part)) continue;
    const native = part.attachment.opaque?.wechat as NativeWechatAttachment | undefined;
    if (!native?.itemType) continue;
    const details = nativeMedia(native);
    const encrypted = await fetchMedia(client, mediaUrl(details.media, cdnBaseUrl), maxBytes);
    if (
      details.expectedCipherSize !== undefined &&
      details.expectedCipherSize !== encrypted.byteLength
    ) {
      throw new Error("微信媒体密文长度与消息元数据不一致");
    }
    if (!details.key && details.media.encrypt_type === 1) {
      throw new Error("微信加密媒体缺少 AES key");
    }
    const plaintext = details.key ? decrypt(encrypted, parseAesKey(details.key)) : encrypted;
    if (
      details.expectedPlainSize !== undefined &&
      details.expectedPlainSize !== plaintext.byteLength
    ) {
      throw new Error("微信媒体明文长度与消息元数据不一致");
    }
    if (
      details.expectedMd5 &&
      createHash("md5").update(plaintext).digest("hex").toLowerCase() !==
        details.expectedMd5.toLowerCase()
    ) {
      throw new Error("微信媒体 MD5 校验失败");
    }
    const mimeType = detectedMime(part.type, plaintext, details.name ?? part.attachment.name);
    const checksum = `sha256:${createHash("sha256").update(plaintext).digest("hex")}`;
    const path = await saveInboundMedia(
      directory,
      message.messageId,
      index,
      plaintext,
      extension(part.type, details.name ?? part.attachment.name, mimeType),
    );
    const name = details.name ?? part.attachment.name;
    part.attachment = {
      localPath: path,
      ...(name ? { name } : {}),
      mimeType,
      size: plaintext.byteLength,
      checksum,
    };
  }
  return materialized;
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
  let plaintext: Buffer;
  if (attachment.localPath) {
    plaintext = await readFile(attachment.localPath);
  } else {
    if (!attachment.url) throw new Error(`微信 ${type} 发送缺少可访问 URL 或本地文件`);
    const source = await client.fetch(attachment.url);
    if (!source.ok) throw new Error(`媒体下载失败: HTTP ${source.status}`);
    plaintext = Buffer.from(await source.arrayBuffer());
  }
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
