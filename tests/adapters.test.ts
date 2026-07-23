import assert from "node:assert/strict";
import { test } from "node:test";
import { QqAdapter, normalizeQqDispatch, QqCompatibilityError } from "@agent-pigeon/adapter-qq";
import {
  WechatIlinkAdapter,
  normalizeWechatMessage,
  WechatCompatibilityError,
} from "@agent-pigeon/adapter-wechat-ilink";

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
  assert.throws(
    () => normalizeQqDispatch({ op: 0, t: "SOMETHING_NEW", d: {} }, "qq-main", "app"),
    QqCompatibilityError,
  );
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

test("QQ adapter enforces the direct-message four-reply limit", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("getAppAccessToken")) {
      return Response.json({ access_token: "access", expires_in: 3600 });
    }
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
  await assert.rejects(adapter.send({ ...base, idempotencyKey: "reply-5" }), /四-reply|上限|4/);
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
