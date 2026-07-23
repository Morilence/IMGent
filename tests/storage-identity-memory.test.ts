import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { conversationKey } from "@agent-pigeon/contracts";
import { ApprovalService } from "../src/approvals/service.js";
import { IdentityService } from "../src/identity/service.js";
import { MemoryCurator } from "../src/memory/curator.js";
import { MemoryService } from "../src/memory/service.js";
import { redactForLog } from "../src/runtime/logger.js";
import { SecretBox } from "../src/security/secret-box.js";
import { PigeonStore } from "../src/storage/store.js";
import { directMessage, testStore } from "./helpers.js";

test("ingest is atomic, idempotent and advances checkpoints", async () => {
  const fixture = await testStore();
  try {
    const message = directMessage();
    const key = conversationKey("main", message);
    const first = fixture.store.ingest(message, "main", key, {
      key: "gateway_resume",
      value: "one",
    });
    const duplicate = fixture.store.ingest(message, "main", key, {
      key: "gateway_resume",
      value: "two",
    });
    assert.equal(first.duplicate, false);
    assert.ok(first.taskId);
    assert.equal(duplicate.duplicate, true);
    assert.equal(fixture.store.checkpoint("qq-main", "gateway_resume"), "two");
    assert.equal(
      fixture.store.get<{ count: number }>("SELECT count(*) AS count FROM tasks")?.count,
      1,
    );
    const stored = fixture.store.get<{
      message_json: string;
      reply_context_cipher: Uint8Array;
    }>("SELECT message_json, reply_context_cipher FROM inbound_events WHERE id = ?", first.eventId);
    assert.ok(stored);
    assert.doesNotMatch(stored.message_json, /short-lived-secret/);
    assert.match(
      JSON.stringify(fixture.store.decryptReplyContext(stored.reply_context_cipher)),
      /short-lived-secret/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("scheduler claims FIFO per conversation while allowing another conversation", async () => {
  const fixture = await testStore();
  try {
    const a1 = directMessage({ messageId: "a1", dedupeKey: "a1" });
    const a2 = directMessage({ messageId: "a2", dedupeKey: "a2" });
    const b1 = directMessage({
      messageId: "b1",
      dedupeKey: "b1",
      conversation: {
        kind: "direct",
        platformConversationId: "user-2",
      },
      actor: { platformUserId: "user-2" },
    });
    const keyA = conversationKey("main", a1);
    const keyB = conversationKey("main", b1);
    fixture.store.ingest(a1, "main", keyA);
    fixture.store.ingest(a2, "main", keyA);
    fixture.store.ingest(b1, "main", keyB);
    assert.equal(fixture.store.claimNextTask()?.message.messageId, "a1");
    assert.equal(fixture.store.claimNextTask()?.message.messageId, "b1");
    assert.equal(fixture.store.claimNextTask(), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("restart recovery requeues safe work and dead-letters possibly executed work", async () => {
  const directory = await (
    await import("node:fs/promises")
  ).mkdtemp(`${(await import("node:os")).tmpdir()}/agent-pigeon-restart-`);
  const key = randomBytes(32);
  const path = `${directory}/state.sqlite`;
  let store = await PigeonStore.open(path, new SecretBox(key));
  const first = store.ingest(
    directMessage({ messageId: "safe", dedupeKey: "safe" }),
    "main",
    "safe",
  );
  const second = store.ingest(
    directMessage({ messageId: "unsafe", dedupeKey: "unsafe" }),
    "main",
    "unsafe",
  );
  assert.equal(store.claimNextTask()?.id, first.taskId);
  assert.equal(store.claimNextTask()?.id, second.taskId);
  store.markDangerousSideEffect(second.taskId!);
  store.close();
  store = await PigeonStore.open(path, new SecretBox(key));
  const recovered = store.recoverAfterRestart();
  assert.deepEqual(recovered, { requeued: 1, deadLettered: 1 });
  assert.equal(store.task(first.taskId!)?.status, "queued");
  assert.equal(store.task(second.taskId!)?.status, "dead_letter");
  store.close();
  await (
    await import("node:fs/promises")
  ).rm(directory, {
    recursive: true,
    force: true,
  });
});

test("pairing and explicit cross-platform binding merge principals without display-name matching", async () => {
  const fixture = await testStore();
  try {
    const first = fixture.store.ingest(
      directMessage(),
      "main",
      "qq-conversation",
      undefined,
      false,
    );
    const secondMessage = directMessage({
      platform: "wechat-ilink",
      botInstanceId: "wechat-main",
      messageId: "wx-1",
      dedupeKey: "wx-1",
      conversation: {
        kind: "direct",
        platformConversationId: "wx-user",
      },
      actor: {
        platformUserId: "wx-user",
        displayName: "User",
      },
    });
    const second = fixture.store.ingest(
      secondMessage,
      "main",
      "wechat-conversation",
      undefined,
      false,
    );
    assert.notEqual(first.principalId, second.principalId);
    const identities = new IdentityService(fixture.store);
    identities.confirmPairing(identities.createPairingCode(first.platformIdentityId));
    const code = identities.createBindingCode(first.platformIdentityId);
    const result = identities.consumeBindingCode(code, second.platformIdentityId);
    assert.equal(result.principalId, first.principalId);
    assert.equal(
      fixture.store.get<{ principal_id: string }>(
        "SELECT principal_id FROM platform_identities WHERE id = ?",
        second.platformIdentityId,
      )?.principal_id,
      first.principalId,
    );
    assert.equal(identities.isPaired(second.platformIdentityId), true);
  } finally {
    await fixture.cleanup();
  }
});

test("memory search enforces personal and group scope boundaries", async () => {
  const fixture = await testStore();
  try {
    const first = fixture.store.ingest(directMessage(), "main", "direct-one", undefined, false);
    const other = fixture.store.ingest(
      directMessage({
        messageId: "other",
        dedupeKey: "other",
        conversation: {
          kind: "direct",
          platformConversationId: "other",
        },
        actor: { platformUserId: "other" },
      }),
      "main",
      "direct-other",
      undefined,
      false,
    );
    const memory = new MemoryService(fixture.store);
    const context = {
      agentProfileId: "main",
      principalId: first.principalId,
      conversationSpaceId: first.conversationSpaceId,
      conversationKey: "direct-one",
      conversationKind: "direct" as const,
      sourceMessageIds: ["message-1"],
    };
    memory.remember(context, {
      target: "self",
      kind: "preference",
      factKey: "reply.style",
      value: "偏好非常简洁的中文回复",
    });
    assert.equal(memory.search(context, "简洁 中文").length, 1);
    assert.equal(
      memory.search(
        {
          ...context,
          principalId: other.principalId,
          conversationSpaceId: other.conversationSpaceId,
        },
        "简洁 中文",
      ).length,
      0,
    );
    memory.remember(context, {
      target: "self",
      kind: "preference",
      factKey: "reply.style",
      value: "偏好详细的中文回复",
    });
    assert.equal(memory.search(context, "详细 中文").length, 1);
    assert.equal(
      fixture.store.get<{ count: number }>(
        `SELECT count(*) AS count FROM memory_records
         WHERE fact_key = 'reply.style' AND status = 'active'`,
      )?.count,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("approvals are idempotent and bound to principal and conversation", async () => {
  const fixture = await testStore();
  try {
    const ingested = fixture.store.ingest(directMessage(), "main", "conversation-one");
    const task = fixture.store.claimNextTask();
    assert.equal(task?.id, ingested.taskId);
    const approvals = new ApprovalService(fixture.store);
    approvals.create(task!.id, "main", "conversation-one", ingested.principalId, {
      requestId: "approval-1",
      toolName: "shell",
      sanitizedInput: { command: "pwd" },
      risk: "high",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.throws(
      () =>
        approvals.decide(
          "approval-1",
          ingested.principalId,
          { decision: "allow" },
          "another-conversation",
        ),
      /原会话/,
    );
    const allowed = approvals.decide(
      "approval-1",
      ingested.principalId,
      { decision: "allow" },
      "conversation-one",
    );
    assert.equal(allowed.changed, true);
    assert.equal(
      approvals.decide("approval-1", ingested.principalId, { decision: "deny" }, "conversation-one")
        .changed,
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("full-mode group context gets seven-day retention and asynchronous scoped curation", async () => {
  const fixture = await testStore();
  try {
    const triggered = directMessage({
      messageId: "group-trigger",
      dedupeKey: "group-trigger",
      conversation: {
        kind: "group",
        platformConversationId: "group-1",
      },
      actor: {
        platformUserId: "member-1",
        platformMemberId: "member-1",
        role: "member",
      },
      parts: [{ type: "text", text: "@bot hello" }],
    });
    const first = fixture.store.ingest(triggered, "main", "group-key", undefined, false);
    fixture.store.run(
      "UPDATE group_policies SET mode = 'full' WHERE conversation_space_id = ?",
      first.conversationSpaceId,
    );
    const ordinary = {
      ...triggered,
      messageId: "group-ordinary",
      dedupeKey: "group-ordinary",
      parts: [{ type: "text" as const, text: "请记住 本群发布前必须运行集成测试" }],
      triggered: false,
    };
    const ingested = fixture.store.ingest(ordinary, "main", "group-key", undefined, false);
    assert.equal(ingested.taskId, undefined);
    const raw = fixture.store.get<{ raw_expires_at: string | null }>(
      "SELECT raw_expires_at FROM inbound_events WHERE id = ?",
      ingested.eventId,
    );
    assert.ok(raw?.raw_expires_at);
    assert.ok(Date.parse(raw.raw_expires_at) > Date.now());
    const curator = new MemoryCurator(fixture.store, new MemoryService(fixture.store));
    assert.equal(await curator.processOnce(), true);
    const records = new MemoryService(fixture.store).search(
      {
        agentProfileId: "main",
        principalId: ingested.principalId,
        conversationSpaceId: ingested.conversationSpaceId,
        conversationKey: "group-key",
        conversationKind: "group",
        sourceMessageIds: ["group-ordinary"],
      },
      "发布前 集成测试",
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]?.scopeType, "group_shared");
    fixture.store.run(
      "UPDATE inbound_events SET raw_expires_at = ? WHERE id = ?",
      new Date(Date.now() - 1_000).toISOString(),
      ingested.eventId,
    );
    assert.equal(fixture.store.cleanupExpiredRawEvents(), 1);
    assert.equal(
      fixture.store.get<{ message_json: string }>(
        "SELECT message_json FROM inbound_events WHERE id = ?",
        ingested.eventId,
      )?.message_json,
      '{"expired":true}',
    );
  } finally {
    await fixture.cleanup();
  }
});

test("default log redaction scrubs credential-like values even inside error strings", () => {
  assert.deepEqual(
    redactForLog({
      message: "request failed token=abc123456789 and Bearer abcdefghijklmnop",
      replyContext: { opaque: "value" },
    }),
    {
      message: "request failed [redacted] and [redacted]",
      replyContext: "[redacted]",
    },
  );
});
