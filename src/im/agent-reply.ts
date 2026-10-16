import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { IMGentError, type MessagePart, type Platform } from "@imgent/contracts";

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

export function agentReplyInstructions(platform: Platform): string {
  if (platform !== "wechat-ilink") return "";
  return [
    "# IMGent WeChat delivery",
    "This conversation CAN receive native image, video and file messages through IMGent.",
    "To send an attachment, create or download the actual file inside the current workspace, then include a standalone line in your FINAL answer: MEDIA: /absolute/workspace/path/to/file.png",
    "IMGent consumes that line, uploads the file, and sends it to this conversation. No separate sending tool is needed. Up to 10 files, each at most 100 MiB.",
    "Use a real PNG/JPEG/GIF/WebP for an image or MP4 for a video; other formats are sent as files. Do not fabricate a path, put MEDIA lines in code blocks, or use a URL in place of a local file.",
    "Do not use Markdown image syntax or local download links as a substitute for sending an attachment. Do not say the channel cannot send pictures. Describe upload failures honestly; delivery happens after your final answer.",
    "For text, use short paragraphs and lists. WeChat supports bold, links, code and tables, but not inline images, H5/H6 headings, or CJK italics. Avoid unnecessary repeated image/download links.",
  ].join("\n");
}

/** Recognize explicit attachment lines only outside code blocks; never fetch URLs implicitly. */
export function splitAgentReply(text: string): Array<{ text: string } | { path: string }> {
  const result: Array<{ text: string } | { path: string }> = [];
  let pending = "";
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.split(/(?<=\n)/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/u.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (
        marker[1]![0] === fence.marker &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined;
      pending += line;
      continue;
    }
    const media = !fence ? /^MEDIA:\s*(\S[^\r\n]*)\s*$/u.exec(line) : undefined;
    if (media) {
      if (pending.trim()) result.push({ text: pending.trim() });
      pending = "";
      result.push({ path: media[1]!.trim() });
    } else pending += line;
  }
  if (pending.trim()) result.push({ text: pending.trim() });
  return result;
}

function mediaKind(data: Buffer): "image" | "video" | "file" {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    /^(GIF87a|GIF89a)$/u.test(data.subarray(0, 6).toString("ascii")) ||
    (data.subarray(0, 4).toString("ascii") === "RIFF" &&
      data.subarray(8, 12).toString("ascii") === "WEBP")
  )
    return "image";
  if (
    data.subarray(4, 8).toString("ascii") === "ftyp" &&
    /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/u.test(data.subarray(8, 12).toString("ascii"))
  )
    return "video";
  return "file";
}

/** Snapshot workspace attachments before enqueueing so retries survive source-file changes. */
export async function prepareAgentReply(options: {
  text: string;
  platform: Platform;
  workspace: string;
  mediaDirectory: string;
  taskId: string;
}): Promise<MessagePart[]> {
  if (options.platform !== "wechat-ilink") return [{ type: "text", text: options.text }];
  const segments = splitAgentReply(options.text);
  const attachments = segments.filter((segment) => "path" in segment);
  if (attachments.length === 0) return [{ type: "text", text: options.text }];
  try {
    if (attachments.length > MAX_ATTACHMENTS) throw new Error("too many attachments");
    const workspace = await realpath(options.workspace);
    const parts: MessagePart[] = [];
    const seen = new Set<string>();
    for (const segment of segments) {
      if ("text" in segment) {
        parts.push({ type: "text", text: segment.text });
        continue;
      }
      if (!isAbsolute(segment.path)) throw new Error("attachment path must be absolute");
      const path = await realpath(segment.path);
      const within = relative(workspace, path);
      if (
        !within ||
        within === ".." ||
        within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(within)
      ) {
        throw new Error("attachment must be inside the current workspace");
      }
      // Reject last-component symlink swaps after realpath; inspect the opened file itself.
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let data: Buffer;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size === 0 || info.size > MAX_MEDIA_BYTES)
          throw new Error("invalid attachment size or type");
        data = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await file.read(data, offset, data.length - offset, null);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== info.size) throw new Error("attachment changed while reading");
        data = data.subarray(0, offset);
      } finally {
        await file.close();
      }
      const checksum = createHash("sha256").update(data).digest("hex");
      const name = basename(path);
      const key = createHash("sha256")
        .update(`${options.taskId}:${name}:${checksum}`)
        .digest("hex");
      if (seen.has(key)) continue;
      seen.add(key);
      await mkdir(options.mediaDirectory, { recursive: true, mode: 0o700 });
      const localPath = resolve(join(options.mediaDirectory, key));
      await writeFile(localPath, data, { mode: 0o600 });
      parts.push({
        type: mediaKind(data),
        attachment: { localPath, name, size: data.length, checksum: `sha256:${checksum}` },
      });
    }
    return parts;
  } catch (cause) {
    throw new IMGentError("OUTBOUND_MEDIA_INVALID", { cause });
  }
}
