import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { QqAdapter, normalizeQqDispatch, QqCompatibilityError } from "@imgent/adapter-qq";
import {
  WechatIlinkAdapter,
  materializeWechatInboundMedia,
  normalizeWechatMessage,
  WechatCompatibilityError,
} from "@imgent/adapter-wechat-ilink";
import { IMGentError } from "@imgent/contracts";
import type WebSocket from "ws";

class FakeQqSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  receive(payload: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.alloc(0));
  }

  terminate(): void {
    this.close(1006);
  }
}

test("QQ normalizer preserves actor, mentions, references, attachments and reply limits", () => {
  const sentAt = "2026-07-24T00:00:00.000Z";
  const message = normalizeQqDispatch(
    {
      id: "event-1",
      op: 0,
      s: 9,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "message-1",
        content: "@bot 请看",
        timestamp: sentAt,
        group_openid: "group-1",
        author: {
          member_openid: "member-1",
          nickname: "Alice",
          role: "admin",
        },
        mentions: [{ member_openid: "app-1", username: "bot" }],
        message_reference: { message_id: "previous" },
        attachments: [
          {
            url: "https://example.test/image.png",
            filename: "image.png",
            content_type: "image/png",
          },
        ],
      },
    },
    "qq-main",
    "app-1",
    sentAt,
  );
  assert.ok(message);
  assert.equal(message.conversation.kind, "group");
  assert.equal(message.actor.role, "admin");
  assert.equal(message.actor.platformUserId, "member-1");
  assert.equal(message.mentions[0]?.platformUserId, "app-1");
  assert.equal(message.replyTo?.messageId, "previous");
  assert.equal(message.parts[1]?.type, "image");
  assert.equal(message.triggered, true);
  assert.equal(message.replyContext?.expiresAt, "2026-07-24T00:05:00.000Z");
});

test("QQ full group messages are context-only and unknown events fail closed", () => {
  const message = normalizeQqDispatch(
    {
      op: 0,
      s: 1,
      t: "GROUP_MESSAGE_CREATE",
      d: {
        id: "ordinary",
        content: "ordinary message",
        group_openid: "group",
        author: { member_openid: "member" },
      },
    },
    "qq-main",
    "app",
  );
  assert.equal(message?.triggered, false);
  const reply = normalizeQqDispatch(
    {
      op: 0,
      s: 2,
      t: "GROUP_MESSAGE_CREATE",
      d: {
        id: "reply",
        content: "reply to bot",
        group_openid: "group",
        author: { member_openid: "member" },
        message_reference: { message_id: "bot-message" },
      },
    },
    "qq-main",
    "app",
    new Date().toISOString(),
    (messageId) => messageId === "bot-message",
  );
  assert.equal(reply?.triggered, true);
  assert.throws(
    () => normalizeQqDispatch({ op: 0, t: "SOMETHING_NEW", d: {} }, "qq-main", "app"),
    QqCompatibilityError,
  );
});

test("QQ full-group readiness is optional until a full-mode group requires it", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async (input) => {
    requests += 1;
    return String(input).includes("getAppAccessToken")
      ? Response.json({ access_token: "access", expires_in: 3600 })
      : Response.json({ url: "wss://gateway.example.test" });
  };
  const optional = new QqAdapter({
    botInstanceId: "qq-main",
    appId: "app",
    credential: { appSecret: "secret" },
    fetch: fetcher,
    fullGroupEventPermission: false,
  });
  assert.equal((await optional.checkReady("runtime")).ready, true);
  assert.equal(requests, 0);
  assert.equal((await optional.checkReady("diagnostic")).ready, true);
  assert.equal(requests, 2);
  const required = new QqAdapter({
    botInstanceId: "qq-main",
    appId: "app",
    credential: { appSecret: "secret" },
    fetch: fetcher,
    fullGroupEventPermission: false,
    fullGroupEventPermissionRequired: true,
  });
  assert.equal((await required.checkReady()).ready, false);
});

test("QQ authenticates before heartbeat and reports the live Gateway state", async () => {
  let socket: FakeQqSocket | undefined;
  const adapter = new QqAdapter({
    botInstanceId: "qq-main",
    appId: "app",
    credential: { appSecret: "secret" },
    gatewayUrl: "wss://gateway.example.test",
    fetch: async () => Response.json({ access_token: "access", expires_in: 3600 }),
    websocketFactory: () => {
      socket = new FakeQqSocket();
      return socket as unknown as WebSocket;
    },
  });
  const started = adapter.start(async () => undefined);
  while (!socket) await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal((await adapter.checkReady("runtime")).ready, false);
  socket.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
  assert.deepEqual(
    socket.sent.map((payload) => payload.op),
    [2],
  );
  socket.receive({
    op: 0,
    s: 1,
    t: "READY",
    d: { session_id: "session-1" },
  });
  await started;
  assert.equal((await adapter.checkReady("runtime")).ready, true);

  socket.close(1006);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await adapter.checkReady("runtime")).ready, false);
  await adapter.stop();
});

test("WeChat normalizer preserves context token and media while rejecting groups", () => {
  const message = normalizeWechatMessage(
    {
      seq: "7",
      message_id: "wx-1",
      from_user_id: "contact-1",
      context_token: "opaque-context",
      message_type: 1,
      item_list: [
        { type: 1, text_item: { text: "hello" } },
        {
          type: 4,
          file_item: {
            file_name: "report.txt",
            len: "12",
            md5: "abcd",
            media: { aes_key: "key", encrypt_query_param: "query" },
          },
        },
      ],
    },
    "wechat-main",
  );
  assert.ok(message);
  assert.equal(message.conversation.kind, "direct");
  assert.equal(message.replyContext?.opaque.contextToken, "opaque-context");
  assert.equal(message.parts[1]?.type, "file");
  assert.throws(
    () =>
      normalizeWechatMessage(
        {
          seq: 8,
          message_id: "wx-group",
          from_user_id: "contact",
          group_id: "group",
          message_type: 1,
        },
        "wechat-main",
      ),
    WechatCompatibilityError,
  );
});

test("WeChat inbound media is downloaded, decrypted, verified and materialized locally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-wechat-media-"));
  try {
    const plaintext = Buffer.from("verified attachment", "utf8");
    const key = randomBytes(16);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(true);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const message = normalizeWechatMessage(
      {
        seq: "8",
        message_id: "wx-media",
        from_user_id: "contact-1",
        message_type: 1,
        item_list: [
          {
            type: 4,
            file_item: {
              file_name: "note.txt",
              len: String(plaintext.byteLength),
              md5: createHash("md5").update(plaintext).digest("hex"),
              media: {
                full_url: "https://cdn.example.test/download",
                aes_key: key.toString("base64"),
              },
            },
          },
        ],
      },
      "wechat-main",
    );
    assert.ok(message);
    const result = await materializeWechatInboundMedia(
      {
        fetch: async () => new Response(encrypted),
        post: async () => {
          throw new Error("not used");
        },
      },
      message,
      directory,
    );
    const part = result.parts[0];
    assert.equal(part?.type, "file");
    if (!part || part.type !== "file") throw new Error("file part missing");
    assert.deepEqual(await readFile(part.attachment.localPath!), plaintext);
    assert.equal(part.attachment.size, plaintext.byteLength);
    assert.equal(part.attachment.mimeType, "text/plain");
    assert.match(part.attachment.checksum ?? "", /^sha256:[0-9a-f]{64}$/u);
    assert.equal(part.attachment.opaque, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("QQ adapter enforces the direct-message four-reply limit", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("getAppAccessToken")) {
      return Response.json({ access_token: "access", expires_in: 3600 });
    }
    sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ id: `sent-${Date.now()}` });
  };
  const adapter = new QqAdapter({
    botInstanceId: "qq-main",
    appId: "app",
    credential: { appSecret: "secret" },
    fetch: fetcher,
  });
  const base = {
    botInstanceId: "qq-main",
    conversation: {
      kind: "direct" as const,
      platformConversationId: "user",
    },
    parts: [{ type: "text" as const, text: "reply" }],
    replyContext: {
      opaque: {
        messageId: "inbound",
        eventId: "message-event",
        initialMsgSeq: 0,
        maxReplies: 4,
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  for (let index = 1; index <= 4; index += 1) {
    assert.equal(
      (
        await adapter.send({
          ...base,
          idempotencyKey: `reply-${index}`,
        })
      ).mode,
      "reply",
    );
  }
  assert.equal(sentBodies[0]?.msg_id, "inbound");
  assert.equal("event_id" in (sentBodies[0] ?? {}), false);
  await assert.rejects(
    adapter.send({ ...base, idempotencyKey: "reply-5" }),
    (error: unknown) => error instanceof IMGentError && error.code === "OUTBOUND_CONTEXT_EXPIRED",
  );
});

test("WeChat persists an empty long-poll cursor and probes with ilink_user_id", async () => {
  const checkpoints: string[] = [];
  const requestBodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    calls += 1;
    if (calls === 1) {
      return Response.json({
        ret: 0,
        msgs: [],
        get_updates_buf: "cursor-next",
        longpolling_timeout_ms: 5_000,
      });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };
  const adapter = new WechatIlinkAdapter({
    botInstanceId: "wechat-main",
    platformBotId: "bot-id",
    authorizingPlatformUserId: "scanner-user-id",
    credential: { botToken: "token" },
    baseUrl: "https://example.test",
    fetch: fetcher,
    onCheckpoint: async (checkpoint) => {
      checkpoints.push(checkpoint.value);
    },
  });
  await adapter.start(async () => undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await adapter.stop();
  assert.deepEqual(checkpoints, ["cursor-next"]);
  assert.equal(requestBodies[0]?.get_updates_buf, "");

  const readinessBodies: Record<string, unknown>[] = [];
  const readiness = new WechatIlinkAdapter({
    botInstanceId: "wechat-main",
    platformBotId: "bot-id",
    authorizingPlatformUserId: "scanner-user-id",
    credential: { botToken: "token" },
    baseUrl: "https://example.test",
    fetch: async (_input, init) => {
      readinessBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ret: 0 });
    },
  });
  assert.equal((await readiness.checkReady()).ready, true);
  assert.equal(readinessBodies[0]?.ilink_user_id, "scanner-user-id");
});

test("adapter authentication and rate-limit failures expose stable recovery policy", async () => {
  const unauthorized = new QqAdapter({
    botInstanceId: "qq-main",
    appId: "app",
    credential: { appSecret: "secret" },
    fetch: async () => new Response("", { status: 401 }),
  });
  const readiness = await unauthorized.checkReady();
  assert.equal(readiness.ready, false);
  assert.equal(
    readiness.issues.some((issue) => issue.code === "ADAPTER_AUTH_REQUIRED"),
    true,
  );

  let calls = 0;
  const limited = new QqAdapter({
    botInstanceId: "qq-main",
    appId: "app",
    credential: { appSecret: "secret" },
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ access_token: "access", expires_in: 3600 });
      }
      return new Response("", {
        status: 429,
        headers: { "Retry-After": "9999" },
      });
    },
  });
  await assert.rejects(
    limited.send({
      botInstanceId: "qq-main",
      conversation: { kind: "direct", platformConversationId: "user" },
      parts: [{ type: "text", text: "hello" }],
      idempotencyKey: "limited",
    }),
    (error: unknown) =>
      error instanceof IMGentError &&
      error.code === "ADAPTER_RATE_LIMITED" &&
      error.descriptor.retry.retryAfterMs === 300_000,
  );
});

test("WeChat invalid sessions stop polling and transient disconnects recover", async () => {
  let invalidMessage = "";
  let invalidResolve: (() => void) | undefined;
  const invalidObserved = new Promise<void>((resolve) => {
    invalidResolve = resolve;
  });
  const invalid = new WechatIlinkAdapter({
    botInstanceId: "wechat-main",
    platformBotId: "bot-id",
    credential: { botToken: "token" },
    baseUrl: "https://example.test",
    fetch: async () =>
      Response.json({ ret: 0, errcode: -14, errmsg: "raw session invalid response" }),
    onSessionInvalid: async (message) => {
      invalidMessage = message;
      invalidResolve?.();
    },
  });
  await invalid.start(async () => undefined);
  await invalidObserved;
  assert.match(invalidMessage, /session invalid/);
  assert.equal(
    (await invalid.checkReady()).issues.some((issue) => issue.code === "ADAPTER_SESSION_INVALID"),
    true,
  );
  await invalid.stop();

  let calls = 0;
  let messageResolve: (() => void) | undefined;
  const messageObserved = new Promise<void>((resolve) => {
    messageResolve = resolve;
  });
  const recovering = new WechatIlinkAdapter({
    botInstanceId: "wechat-main",
    platformBotId: "bot-id",
    credential: { botToken: "token" },
    baseUrl: "https://example.test",
    fetch: async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("temporary disconnect"), { code: "ECONNRESET" });
      }
      if (calls === 2) {
        return Response.json({
          ret: 0,
          msgs: [
            {
              from_user_id: "user",
              message_id: "recovered",
              seq: 1,
              item_list: [{ type: 1, text_item: { text: "hello" } }],
              context_token: "reply-context",
            },
          ],
          get_updates_buf: "after-recovery",
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    },
  });
  await recovering.start(async () => {
    messageResolve?.();
  });
  await messageObserved;
  assert.ok(calls >= 2);
  await recovering.stop();
});
