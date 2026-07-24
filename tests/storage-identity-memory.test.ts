import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { conversationKey, IMGentError } from "@imgent/contracts";
import { ApprovalService } from "../src/approvals/service.js";
import { IdentityService } from "../src/identity/service.js";
import { MemoryCurator } from "../src/memory/curator.js";
import { MemoryHostTools } from "../src/memory/host-tools.js";
import { MemoryService } from "../src/memory/service.js";
import { IMGentHostTools } from "../src/runtime/host-tools.js";
import { redactForLog } from "../src/runtime/logger.js";
import { SecretBox } from "../src/security/secret-box.js";
import { SkillHostTools } from "../src/skills/host-tools.js";
import { builtInSkillsDirectory } from "../src/skills/paths.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { IMGentStore } from "../src/storage/store.js";
import { directMessage, testStore } from "./helpers.js";
import type {
  AgentDriver,
  AgentEvent,
  AgentProfile,
  AgentRequestAnswer,
  AgentTurnInput,
  DriverReadiness,
} from "@imgent/contracts";

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
  ).mkdtemp(`${(await import("node:os")).tmpdir()}/imgent-restart-`);
  const key = randomBytes(32);
  const path = `${directory}/state.sqlite`;
  let store = await IMGentStore.open(path, new SecretBox(key));
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
  store = await IMGentStore.open(path, new SecretBox(key));
  const recovered = store.recoverAfterRestart();
  assert.deepEqual(recovered, { requeued: 1, deadLettered: 1 });
  assert.equal(store.task(first.taskId!)?.status, "retry_wait");
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
    identities.setLocale(second.principalId, "en-US");
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
    assert.equal(identities.locale(first.principalId), "en-US");
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
    const mixed = memory.remember(context, {
      target: "self",
      kind: "fact",
      factKey: "project.release",
      value: "项目代号蓝鲸，release train 每周五发布",
    });
    assert.equal(memory.search(context, "蓝鲸 release")[0]?.id, mixed.id);
    assert.equal(memory.search(context, "蓝鲸")[0]?.id, mixed.id);
    memory.remember(context, {
      target: "self",
      kind: "episode",
      value: "即将过期的蓝鲸里程碑",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(
      memory.search(context, "过期 里程碑").some((record) => record.value.includes("即将过期")),
      false,
    );
    assert.throws(
      () =>
        memory.remember(context, {
          target: "self",
          kind: "fact",
          value: "api_key=abcdefghijklmnop",
        }),
      /不能写入长期记忆/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("all five memory scopes remain isolated and explicit Host Tool writes return receipts", async () => {
  const fixture = await testStore();
  try {
    const direct = fixture.store.ingest(
      directMessage({ messageId: "scope-direct", dedupeKey: "scope-direct" }),
      "main",
      "scope-direct",
      undefined,
      false,
    );
    const groupMessage = directMessage({
      messageId: "scope-group",
      dedupeKey: "scope-group",
      conversation: { kind: "group", platformConversationId: "scope-group" },
      actor: {
        platformUserId: "user-1",
        platformMemberId: "member-1",
        role: "admin",
      },
    });
    const group = fixture.store.ingest(groupMessage, "main", "scope-group", undefined, false);
    const memory = new MemoryService(fixture.store);
    const directContext = {
      agentProfileId: "main",
      principalId: direct.principalId,
      conversationSpaceId: direct.conversationSpaceId,
      conversationKey: "scope-direct",
      conversationKind: "direct" as const,
      sourceMessageIds: ["scope-direct"],
    };
    const groupContext = {
      ...directContext,
      principalId: group.principalId,
      conversationSpaceId: group.conversationSpaceId,
      conversationKey: "scope-group",
      conversationKind: "group" as const,
      sourceMessageIds: ["scope-group"],
      actorIsGroupAdmin: true,
    };
    const tools = new MemoryHostTools(memory);
    tools.register("explicit-turn", directContext);
    const receipt = await tools.handle({
      turnId: "explicit-turn",
      namespace: "memory",
      name: "remember",
      arguments: {
        target: "self",
        kind: "fact",
        value: "scopeproof personal",
      },
    });
    assert.equal(receipt.success, true);
    assert.match(receipt.text, /已记住/);
    const privateEpisode = memory.remember(directContext, {
      target: "episode",
      kind: "episode",
      value: "scopeproof private episode",
    });
    memory.remember(groupContext, {
      target: "self",
      kind: "fact",
      value: "scopeproof group member",
    });
    memory.remember(groupContext, {
      target: "group",
      kind: "decision",
      value: "scopeproof group shared",
    });
    memory.remember(groupContext, {
      target: "episode",
      kind: "episode",
      value: "scopeproof group episode",
    });
    assert.deepEqual(
      new Set(memory.search(directContext, "scopeproof").map((record) => record.scopeType)),
      new Set(["personal_private", "private_episode"]),
    );
    const anotherDirectEpisode = {
      ...directContext,
      conversationKey: "scope-direct-another-thread",
    };
    assert.deepEqual(
      new Set(memory.search(anotherDirectEpisode, "scopeproof").map((record) => record.scopeType)),
      new Set(["personal_private"]),
    );
    assert.equal(memory.forget(anotherDirectEpisode, privateEpisode.id), false);
    const sameValueOtherEpisode = memory.remember(anotherDirectEpisode, {
      target: "episode",
      kind: "episode",
      value: "scopeproof private episode",
    });
    assert.notEqual(sameValueOtherEpisode.id, privateEpisode.id);
    assert.deepEqual(
      new Set(memory.search(groupContext, "scopeproof").map((record) => record.scopeType)),
      new Set(["group_member", "group_shared", "group_episode"]),
    );
    assert.equal(
      memory.search(
        {
          ...groupContext,
          conversationSpaceId: "another-group",
        },
        "scopeproof",
      ).length,
      0,
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
    approvals.create(
      task!.id,
      "main",
      "conversation-one",
      ingested.principalId,
      {
        requestId: "approval-1",
        toolName: "shell",
        sanitizedInput: { command: "pwd" },
        risk: "high",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        botInstanceId: "qq-main",
        conversation: { kind: "direct", platformConversationId: "user-1" },
        parts: [{ type: "text", text: "approval required" }],
        idempotencyKey: "approval:approval-1",
      },
    );
    assert.equal(fixture.store.task(task!.id)?.status, "waiting_approval");
    assert.equal(
      fixture.store.get<{ count: number }>(
        `SELECT count(*) AS count FROM outbound_messages
         WHERE task_id = ? AND idempotency_key = 'approval:approval-1'`,
        task!.id,
      )?.count,
      1,
    );
    assert.throws(
      () =>
        approvals.decide(
          "approval-1",
          ingested.principalId,
          { decision: "allow" },
          "another-conversation",
        ),
      (error: unknown) => error instanceof IMGentError && error.code === "APPROVAL_FORBIDDEN",
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
    const memory = new MemoryService(fixture.store);
    const skills = await SkillRegistry.load(
      await builtInSkillsDirectory(),
      join(fixture.directory, "skills"),
    );
    const hostTools = new IMGentHostTools(new MemoryHostTools(memory), new SkillHostTools(skills));
    const driver = fakeDriver(async (input) => {
      assert.equal(input.ephemeral, true);
      assert.equal(input.builtInTools, "none");
      assert.deepEqual(input.hostTools, ["memory.search", "memory.remember"]);
      const result = await hostTools.handle({
        turnId: input.turnId,
        namespace: "memory",
        name: "remember",
        arguments: {
          target: "group",
          kind: "decision",
          factKey: "release.integration-tests",
          value: "本群发布前必须运行集成测试",
        },
      });
      assert.equal(result.success, true);
      return [{ type: "completed", result: "success" }];
    });
    const curator = new MemoryCurator({
      store: fixture.store,
      memory,
      profiles: new Map([["main", curatorProfile()]]),
      drivers: new Map([["main", driver]]),
      hostTools,
      skills,
    });
    assert.equal(await curator.processOnce(), true);
    const records = memory.search(
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
    assert.equal(records[0]?.origin, "curated");
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

test("memory curator never performs host-side phrase or regex recognition", async () => {
  const fixture = await testStore();
  try {
    const memory = new MemoryService(fixture.store);
    const skills = await SkillRegistry.load(
      await builtInSkillsDirectory(),
      join(fixture.directory, "skills"),
    );
    const hostTools = new IMGentHostTools(new MemoryHostTools(memory), new SkillHostTools(skills));
    const seenPrompts: string[] = [];
    const driver = fakeDriver((input) => {
      seenPrompts.push(input.prompt);
      return [{ type: "completed", result: "success" }];
    });
    const curator = new MemoryCurator({
      store: fixture.store,
      memory,
      profiles: new Map([["main", curatorProfile()]]),
      drivers: new Map([["main", driver]]),
      hostTools,
      skills,
    });
    for (const [index, text] of [
      "不要记住我的临时安排",
      "你还记住吗？",
      "引用：“请记住蓝色”，这不是我的要求",
    ].entries()) {
      const message = directMessage({
        messageId: `negative-${index}`,
        dedupeKey: `negative-${index}`,
        parts: [{ type: "text", text }],
      });
      const ingested = fixture.store.ingest(message, "main", "negative-memory");
      const task = fixture.store.claimNextTask();
      assert.equal(task?.id, ingested.taskId);
      fixture.store.completeTask(task!.id, "ack", true);
      assert.equal(await curator.processOnce(), true);
    }
    assert.equal(seenPrompts.length, 3);
    assert.equal(
      fixture.store.get<{ count: number }>("SELECT count(*) AS count FROM memory_records")?.count,
      0,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("explicit tool writes and curation for the same source task do not duplicate", async () => {
  const fixture = await testStore();
  try {
    const message = directMessage({
      messageId: "explicit-before-curation",
      dedupeKey: "explicit-before-curation",
      parts: [{ type: "text", text: "请明确保存我的回复风格" }],
    });
    const ingested = fixture.store.ingest(message, "main", "explicit-before-curation");
    const task = fixture.store.claimNextTask()!;
    assert.equal(task.id, ingested.taskId);
    const memory = new MemoryService(fixture.store);
    memory.remember(
      {
        agentProfileId: "main",
        principalId: ingested.principalId,
        conversationSpaceId: ingested.conversationSpaceId,
        conversationKey: "explicit-before-curation",
        conversationKind: "direct",
        sourceMessageIds: [message.messageId],
        sourceTaskId: task.id,
        origin: "explicit",
      },
      {
        target: "self",
        kind: "preference",
        factKey: "reply.style",
        value: "回复保持简洁",
      },
    );
    fixture.store.completeTask(task.id, "已通过工具写入", true);
    const skills = await SkillRegistry.load(
      await builtInSkillsDirectory(),
      join(fixture.directory, "skills"),
    );
    const hostTools = new IMGentHostTools(new MemoryHostTools(memory), new SkillHostTools(skills));
    const driver = fakeDriver(async (input) => {
      const result = await hostTools.handle({
        turnId: input.turnId,
        namespace: "memory",
        name: "remember",
        arguments: {
          target: "self",
          kind: "preference",
          factKey: "reply.style",
          value: "回复保持简洁",
        },
      });
      assert.equal(result.success, true);
      return [{ type: "completed", result: "success" }];
    });
    const curator = new MemoryCurator({
      store: fixture.store,
      memory,
      profiles: new Map([["main", curatorProfile()]]),
      drivers: new Map([["main", driver]]),
      hostTools,
      skills,
    });
    assert.equal(await curator.processOnce(), true);
    const records = fixture.store.all<{ origin: string; count: number }>(
      `SELECT origin, count(*) AS count FROM memory_records
       WHERE source_task_id = ? GROUP BY origin`,
      task.id,
    );
    assert.deepEqual(
      records.map((row) => ({ ...row })),
      [{ origin: "explicit", count: 1 }],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("curator retry is idempotent after a successful tool write", async () => {
  const fixture = await testStore();
  try {
    const message = directMessage({
      messageId: "curator-retry",
      dedupeKey: "curator-retry",
      parts: [{ type: "text", text: "以后回答保持简洁" }],
    });
    fixture.store.ingest(message, "main", "curator-retry");
    const task = fixture.store.claimNextTask()!;
    fixture.store.completeTask(task.id, "好的", true);
    const memory = new MemoryService(fixture.store);
    const skills = await SkillRegistry.load(
      await builtInSkillsDirectory(),
      join(fixture.directory, "skills"),
    );
    const hostTools = new IMGentHostTools(new MemoryHostTools(memory), new SkillHostTools(skills));
    let attempts = 0;
    const driver = fakeDriver(async (input) => {
      attempts += 1;
      const result = await hostTools.handle({
        turnId: input.turnId,
        namespace: "memory",
        name: "remember",
        arguments: {
          target: "self",
          kind: "preference",
          factKey: "reply.style",
          value: "回答保持简洁",
        },
      });
      assert.equal(result.success, true);
      return attempts === 1
        ? [
            {
              type: "error",
              error: new IMGentError("MEMORY_CURATION_FAILED").descriptor,
            },
          ]
        : [{ type: "completed", result: "success" }];
    });
    const curator = new MemoryCurator({
      store: fixture.store,
      memory,
      profiles: new Map([["main", curatorProfile()]]),
      drivers: new Map([["main", driver]]),
      hostTools,
      skills,
    });
    assert.equal(await curator.processOnce(), true);
    const newerMessage = directMessage({
      messageId: "curator-newer",
      dedupeKey: "curator-newer",
      parts: [{ type: "text", text: "改为详细回答" }],
    });
    const newerIngested = fixture.store.ingest(newerMessage, "main", "curator-retry");
    const newerTask = fixture.store.claimNextTask()!;
    assert.equal(newerTask.id, newerIngested.taskId);
    fixture.store.completeTask(newerTask.id, "好的", false);
    memory.remember(
      {
        agentProfileId: "main",
        principalId: newerIngested.principalId,
        conversationSpaceId: newerIngested.conversationSpaceId,
        conversationKey: "curator-retry",
        conversationKind: "direct",
        sourceMessageIds: ["curator-newer"],
        sourceTaskId: newerTask.id,
        origin: "curated",
      },
      {
        target: "self",
        kind: "preference",
        factKey: "reply.style",
        value: "回答保持详细",
      },
    );
    fixture.store.run(
      "UPDATE memory_outbox SET next_attempt_at = ? WHERE task_id = ?",
      new Date(Date.now() - 1_000).toISOString(),
      task.id,
    );
    assert.equal(await curator.processOnce(), true);
    assert.equal(attempts, 2);
    const rows = fixture.store.all<{
      value: string;
      origin: string;
      source_task_id: string;
      status: string;
    }>(
      `SELECT value, origin, source_task_id, status
       FROM memory_records ORDER BY created_at`,
    );
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          value: "回答保持简洁",
          origin: "curated",
          source_task_id: task.id,
          status: "superseded",
        },
        {
          value: "回答保持详细",
          origin: "curated",
          source_task_id: newerTask.id,
          status: "active",
        },
      ],
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

function curatorProfile(): AgentProfile {
  return {
    id: "main",
    driver: "codex",
    command: "codex",
    workspace: process.cwd(),
    skills: ["*"],
    permissions: { maxMode: "ask" },
    memory: { enabled: true },
  };
}

function fakeDriver(
  run: (input: AgentTurnInput) => Promise<AgentEvent[]> | AgentEvent[],
): AgentDriver {
  return {
    id: "codex",
    checkReady: async (): Promise<DriverReadiness> => ({ ready: true, issues: [] }),
    async *runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent> {
      for (const event of await run(input)) yield event;
    },
    answerRequest: async (_requestId: string, _answer: AgentRequestAnswer): Promise<void> =>
      undefined,
    interrupt: async (): Promise<void> => undefined,
  };
}
