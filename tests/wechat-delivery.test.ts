import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { formatWechatText, WechatIlinkAdapter } from "@imgent/adapter-wechat-ilink";
import { IMGentError } from "@imgent/contracts";
import { prepareAgentReply, splitAgentReply } from "../src/im/agent-reply.js";
import { referencedOutboundMediaPaths } from "../src/storage/media.js";
import { testStore } from "./helpers.js";
import type { MessageItem, WechatMessage } from "@imgent/adapter-wechat-ilink";
import type { OutboundMessage } from "@imgent/contracts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=",
  "base64",
);

test("WeChat preserves supported Markdown and code while filtering unsupported constructs", () => {
  const supported =
    "## 标题\n\n**重点** [链接](https://example.test) *English*\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n`![literal](url)`\n\n```md\n![literal](url)\nMEDIA: /example.png\n```";
  assert.equal(formatWechatText(supported), supported);
  assert.equal(
    formatWechatText("![头像](https://example.test/a_(b).png)"),
    "[头像](<https://example.test/a_(b).png>)",
  );
  assert.equal(
    formatWechatText("![图][pic]\n\n[pic]: https://example.test/a.png"),
    "[图](<https://example.test/a.png>)\n\n[pic]: https://example.test/a.png",
  );
  assert.equal(formatWechatText("![不可访问](/tmp/private.png)"), "不可访问");
  assert.equal(
    formatWechatText("##### 小标题\n*中文* **粗体** ***中英 mixed***"),
    "小标题\n中文 **粗体** **中英 mixed**",
  );
  assert.equal(
    formatWechatText("- ![图](https://example.test/a.png)\n> *引用*"),
    "- [图](<https://example.test/a.png>)\n> 引用",
  );
  assert.equal(
    formatWechatText("\\![示例](https://example.test/a.png)"),
    "\\![示例](https://example.test/a.png)",
  );
});

test("media directives are explicit standalone lines outside literal code", () => {
  const literal =
    "`MEDIA: /inline.png`\n\n    MEDIA: /indented.png\n\n```md\nMEDIA: /fenced.png\n```\n\n~~~\nMEDIA: /tilde.png\n~~~";
  assert.deepEqual(splitAgentReply(literal), [{ text: literal }]);
  assert.deepEqual(splitAgentReply("图片如下\nMEDIA: /workspace/a b.png\n完成"), [
    { text: "图片如下" },
    { path: "/workspace/a b.png" },
    { text: "完成" },
  ]);
});

test("reply attachments are validated, deduplicated and snapshotted for durable retry", async () => {
  const fixture = await testStore();
  try {
    const workspace = join(fixture.directory, "workspace");
    await mkdir(workspace);
    const path = join(workspace, "avatar.png");
    await writeFile(path, png);
    const options = {
      text: `图片\nMEDIA: ${path}\nMEDIA: ${path}`,
      platform: "wechat-ilink" as const,
      workspace,
      mediaDirectory: join(fixture.directory, "media", "outbound"),
      taskId: "task",
    };
    const parts = await prepareAgentReply(options);
    assert.deepEqual(
      parts.map((part) => part.type),
      ["text", "image"],
    );
    const part = parts[1]!;
    assert.ok("attachment" in part);
    assert.notEqual(part.attachment.localPath, path);
    await writeFile(path, "changed");
    assert.deepEqual(await readFile(part.attachment.localPath!), png);
    const outboundId = fixture.store.enqueueOutbound({
      botInstanceId: "wechat-main",
      conversation: { kind: "direct", platformConversationId: "user" },
      parts,
      idempotencyKey: "snapshot",
    });
    assert.deepEqual(referencedOutboundMediaPaths(fixture.store), [part.attachment.localPath]);
    fixture.store.run("UPDATE outbound_messages SET status='sent' WHERE id=?", outboundId);
    assert.deepEqual(referencedOutboundMediaPaths(fixture.store), []);
    const invalid = async (text: string) =>
      assert.rejects(
        prepareAgentReply({ ...options, text }),
        (error: unknown) => error instanceof IMGentError && error.code === "OUTBOUND_MEDIA_INVALID",
      );
    await invalid("MEDIA: https://example.test/picture.png");
    await invalid(`MEDIA: ${join(fixture.directory, "test.sqlite")}`);
    await symlink(join(fixture.directory, "test.sqlite"), join(workspace, "escape.png"));
    await invalid(`MEDIA: ${join(workspace, "escape.png")}`);
    await invalid(`MEDIA: ${join(workspace, "missing.png")}`);
    await invalid(Array.from({ length: 11 }, () => `MEDIA: ${path}`).join("\n"));
    const literal = `MEDIA: ${path}`;
    assert.deepEqual(await prepareAgentReply({ ...options, platform: "qq", text: literal }), [
      { type: "text", text: literal },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("WeChat uploads encrypted media, sends one item per request and retries only unacknowledged items", async () => {
  const fixture = await testStore();
  try {
    const path = join(fixture.directory, "avatar.png");
    await writeFile(path, png);
    const uploads: Array<{ key: string; ciphertext: Buffer }> = [];
    let key = "";
    let failImage = true;
    const sent: WechatMessage[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://cdn.test/upload") {
        uploads.push({ key, ciphertext: Buffer.from(init!.body as Uint8Array) });
        return new Response("", { headers: { "x-encrypted-param": "download" } });
      }
      const body = JSON.parse(String(init?.body)) as {
        aeskey: string;
        rawsize: number;
        rawfilemd5: string;
        msg: WechatMessage;
      };
      assert.equal(new Headers(init?.headers).get("iLink-App-Id"), "bot");
      if (url.endsWith("getuploadurl")) {
        key = body.aeskey;
        assert.equal(body.rawsize, png.length);
        assert.equal(body.rawfilemd5, createHash("md5").update(png).digest("hex"));
        return Response.json({ upload_full_url: "https://cdn.test/upload" });
      }
      assert.ok(url.endsWith("sendmessage"));
      sent.push(body.msg);
      assert.equal(body.msg.item_list?.length, 1);
      assert.equal(body.msg.context_token, "context");
      if (body.msg.item_list?.[0]?.type === 2 && failImage) {
        failImage = false;
        return new Response("", { status: 503 });
      }
      return Response.json({ ret: 0 });
    };
    const makeAdapter = () =>
      new WechatIlinkAdapter({
        botInstanceId: "wechat-main",
        platformBotId: "bot",
        credential: { botToken: "secret" },
        baseUrl: "https://api.test",
        fetch: fetcher,
      });
    const adapter = makeAdapter();
    const message: OutboundMessage = {
      botInstanceId: "wechat-main",
      conversation: { kind: "direct", platformConversationId: "user" },
      replyContext: { opaque: { contextToken: "context" } },
      idempotencyKey: "media-final",
      parts: [
        { type: "text", text: "**图片**" },
        { type: "image", attachment: { localPath: path } },
        { type: "text", text: "结束" },
      ],
    };
    await assert.rejects(adapter.send(message));
    await adapter.send(message);
    assert.deepEqual(
      sent.map((msg) => msg.item_list![0]!.type),
      [1, 2, 2, 1],
    );
    assert.equal(sent[1]!.client_id, sent[2]!.client_id);
    const item = sent[2]!.item_list![0] as MessageItem;
    const keyHex = Buffer.from(item.image_item!.media!.aes_key!, "base64").toString("ascii");
    assert.match(keyHex, /^[0-9a-f]{32}$/u);
    const upload = uploads.at(-1)!;
    assert.equal(keyHex, upload.key);
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
    assert.deepEqual(Buffer.concat([decipher.update(upload.ciphertext), decipher.final()]), png);
    assert.equal(item.image_item!.mid_size, upload.ciphertext.length);
    await adapter.send(message);
    assert.equal(sent.length, 4);
    await makeAdapter().send(message);
    assert.equal(sent[4]!.client_id, sent[0]!.client_id);
  } finally {
    await fixture.cleanup();
  }
});
