import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { IMGentError } from "@imgent/contracts";
import { ApprovalService } from "../src/approvals/service.js";
import { MemoryHostTools } from "../src/memory/host-tools.js";
import { MemoryService } from "../src/memory/service.js";
import { ConversationScheduler } from "../src/queue/scheduler.js";
import { IMGentHostTools } from "../src/runtime/host-tools.js";
import { OutboundDispatcher } from "../src/runtime/outbound.js";
import { SkillHostTools } from "../src/skills/host-tools.js";
import { builtInSkillsDirectory } from "../src/skills/paths.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { directMessage, testStore } from "./helpers.js";
import type {
  AdapterReadiness,
  AgentDriver,
  AgentEvent,
  AgentProfile,
  AgentRequestAnswer,
  AgentTurnInput,
  AgentSteerInput,
  DriverReadiness,
  ImAdapter,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from "@imgent/contracts";

function fakeDriver(
  events: (input: AgentTurnInput) => Promise<readonly AgentEvent[]>,
): AgentDriver {
  return {
    id: "codex",
    checkReady: async (): Promise<DriverReadiness> => ({ ready: true, issues: [] }),
    async *runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent> {
      for (const event of await events(input)) yield event;
    },
    answerRequest: async (_requestId: string, _answer: AgentRequestAnswer): Promise<void> =>
      undefined,
    interrupt: async (_turnId: string): Promise<void> => undefined,
  };
}

function fakeAdapter(): ImAdapter {
  return {
    id: "qq",
    capabilities: {
      conversationKinds: ["direct", "group"],
      groupIngestion: "triggered",
      threads: false,
      inboundTransport: "websocket",
      requiresReplyContext: false,
      supportsProactiveSend: true,
    },
    checkReady: async (): Promise<AdapterReadiness> => ({ ready: true, issues: [] }),
    start: async (
      _onMessage: (
        message: InboundMessage,
        checkpoint?: { key: string; value: string },
      ) => Promise<void>,
    ) => undefined,
    stop: async () => undefined,
    send: async (_message: OutboundMessage): Promise<SendResult> => ({
      platformMessageId: "sent",
      mode: "reply",
    }),
  };
}

async function schedulerFixture(
  driver: AgentDriver,
  workspaceFor?: (principalId: string, conversationSpaceId: string) => string | undefined,
  memoryEnabled = false,
  followUpMode?: "steer" | "queue",
): Promise<{
  fixture: Awaited<ReturnType<typeof testStore>>;
  scheduler: ConversationScheduler;
}> {
  const fixture = await testStore();
  const memory = new MemoryService(fixture.store);
  const skills = await SkillRegistry.load(
    await builtInSkillsDirectory(),
    join(fixture.directory, "skills"),
  );
  const hostTools = new IMGentHostTools(new MemoryHostTools(memory), new SkillHostTools(skills));
  const profile: AgentProfile = {
    id: "main",
    driver: "codex",
    command: "fake",
    agentUserHome: fixture.directory,
    workspace: fixture.directory,
    skills: ["*"],
    permissions: { maxMode: "ask" },
    memory: { enabled: memoryEnabled },
    ...(followUpMode ? { followUpMode } : {}),
  };
  const outbound = new OutboundDispatcher(fixture.store);
  const scheduler = new ConversationScheduler({
    store: fixture.store,
    profiles: new Map([["main", profile]]),
    drivers: new Map([["main", driver]]),
    adapters: new Map([
      ["qq-main", fakeAdapter()],
      ["wechat-main", fakeAdapter()],
    ]),
    approvals: new ApprovalService(fixture.store),
    memory,
    hostTools,
    skills,
    outbound,
    ...(workspaceFor ? { workspaceFor } : {}),
  });
  return { fixture, scheduler };
}

test("scheduler teaches native WeChat delivery and commits attachments with the completed task", async () => {
  const driver = fakeDriver(async (input) => {
    assert.match(input.developerInstructions ?? "", /CAN receive native image/);
    const path = join(input.profile.workspace, "report.txt");
    await writeFile(path, "attachment contents");
    return [
      { type: "output-final", text: `文件如下\nMEDIA: ${path}` },
      { type: "completed", result: "success" },
    ];
  });
  const { fixture, scheduler } = await schedulerFixture(driver);
  try {
    const ingested = fixture.store.ingest(
      directMessage({ platform: "wechat-ilink", botInstanceId: "wechat-main" }),
      "main",
      "wechat-media",
    );
    await scheduler.processOnce();
    assert.equal(fixture.store.task(ingested.taskId!)?.status, "succeeded");
    const row = fixture.store.get<{ payload_json: string }>(
      "SELECT payload_json FROM outbound_messages WHERE task_id=?",
      ingested.taskId!,
    );
    const message = JSON.parse(row!.payload_json) as OutboundMessage;
    assert.deepEqual(
      message.parts.map((part) => part.type),
      ["text", "file"],
    );
    assert.equal(message.idempotencyKey, `${ingested.taskId}:final`);
  } finally {
    await scheduler.stop();
    await fixture.cleanup();
  }
});

test("scheduler reports an invalid WeChat attachment instead of claiming successful delivery", async () => {
  const driver = fakeDriver(async () => [
    { type: "output-final", text: "MEDIA: /outside/workspace/missing.png" },
    { type: "completed", result: "success" },
  ]);
  const { fixture, scheduler } = await schedulerFixture(driver);
  try {
    const ingested = fixture.store.ingest(
      directMessage({ platform: "wechat-ilink", botInstanceId: "wechat-main" }),
      "main",
      "wechat-invalid-media",
    );
    await scheduler.processOnce();
    assert.notEqual(fixture.store.task(ingested.taskId!)?.status, "succeeded");
    assert.equal(fixture.store.task(ingested.taskId!)?.error?.code, "OUTBOUND_MEDIA_INVALID");
    const row = fixture.store.get<{ payload_json: string }>(
      "SELECT payload_json FROM outbound_messages WHERE task_id=?",
      ingested.taskId!,
    );
    assert.match(row?.payload_json ?? "", /附件无法读取/);
    assert.doesNotMatch(row?.payload_json ?? "", /outside\/workspace/);
  } finally {
    await scheduler.stop();
    await fixture.cleanup();
  }
});

test("scheduler uses the resolved Principal workspace and leaves Agent replies unprefixed", async () => {
  let observed: AgentTurnInput | undefined;
  const driver = fakeDriver(async (input) => {
    observed = input;
    return [
      { type: "session", sessionId: "workspace-session" },
      { type: "output-final", text: "Agent answer" },
      { type: "completed", result: "success" },
    ];
  });
  let resolvedWorkspace = "";
  const { fixture, scheduler } = await schedulerFixture(driver, () => resolvedWorkspace);
  try {
    resolvedWorkspace = join(fixture.directory, "principal-workspace");
    await mkdir(resolvedWorkspace);
    const ingested = fixture.store.ingest(
      directMessage({ messageId: "workspace-task", dedupeKey: "workspace-task" }),
      "main",
      "workspace-conversation",
    );
    assert.equal(await scheduler.processOnce(), true);
    assert.equal(observed?.profile.workspace, resolvedWorkspace);
    assert.equal(fixture.store.session("workspace-conversation")?.workspace, resolvedWorkspace);
    const payload = fixture.store.get<{ payload_json: string }>(
      "SELECT payload_json FROM outbound_messages WHERE task_id = ?",
      ingested.taskId!,
    )?.payload_json;
    assert.match(payload ?? "", /Agent answer/);
    assert.doesNotMatch(payload ?? "", /\[IMGent:/);
  } finally {
    await scheduler.stop();
    await fixture.cleanup();
  }
});

test("one group session carries distinct stable speaker context for each member", async () => {
  const observed: AgentTurnInput[] = [];
  const { fixture, scheduler } = await schedulerFixture(
    fakeDriver(async (input) => {
      observed.push(input);
      return [
        { type: "session", sessionId: "group-session" },
        { type: "output-final", text: "ok" },
        { type: "completed", result: "success" },
      ];
    }),
  );
  try {
    const group = {
      kind: "group" as const,
      platformConversationId: "group-speakers",
    };
    fixture.store.ingest(
      directMessage({
        messageId: "speaker-one",
        dedupeKey: "speaker-one",
        conversation: group,
        actor: {
          platformUserId: "user-one",
          platformMemberId: "member-one",
          displayName: "同名用户",
          role: "member",
        },
        parts: [{ type: "text", text: "first" }],
      }),
      "main",
      "group-speakers-key",
    );
    fixture.store.ingest(
      directMessage({
        messageId: "speaker-two",
        dedupeKey: "speaker-two",
        conversation: group,
        actor: {
          platformUserId: "user-two",
          platformMemberId: "member-two",
          displayName: "同名用户",
          role: "admin",
        },
        parts: [{ type: "text", text: "second" }],
      }),
      "main",
      "group-speakers-key",
    );

    assert.equal(await scheduler.processOnce(), true);
    assert.equal(await scheduler.processOnce(), true);
    assert.equal(observed.length, 2);
    assert.equal(observed[0]?.context.origin, "im");
    assert.equal(observed[0]?.context.conversation.kind, "group");
    assert.equal(observed[0]?.context.conversation.ref, observed[1]?.context.conversation.ref);
    assert.notEqual(observed[0]?.context.speaker.ref, observed[1]?.context.speaker.ref);
    assert.equal(observed[0]?.context.speaker.displayName, "同名用户");
    assert.equal(observed[0]?.context.speaker.role, "member");
    assert.equal(observed[1]?.context.speaker.role, "admin");
    assert.equal(observed[0]?.prompt, "first");
    assert.equal(observed[1]?.prompt, "second");
  } finally {
    await scheduler.stop();
    await fixture.cleanup();
  }
});

test("attachment-only turns still receive scoped baseline memory", async () => {
  let observed: AgentTurnInput | undefined;
  const { fixture, scheduler } = await schedulerFixture(
    fakeDriver(async (input) => {
      observed = input;
      return [
        { type: "output-final", text: "ok" },
        { type: "completed", result: "success" },
      ];
    }),
    undefined,
    true,
  );
  try {
    const identity = fixture.store.ingest(
      directMessage({
        messageId: "attachment-identity",
        dedupeKey: "attachment-identity",
      }),
      "main",
      "attachment-memory",
      undefined,
      false,
    );
    new MemoryService(fixture.store).remember(
      {
        agentProfileId: "main",
        principalId: identity.principalId,
        conversationSpaceId: identity.conversationSpaceId,
        conversationKey: "attachment-memory",
        conversationKind: "direct",
        sourceMessageIds: ["attachment-identity"],
      },
      {
        target: "self",
        kind: "preference",
        factKey: "reply.style",
        value: "回答保持简洁",
      },
    );
    fixture.store.ingest(
      directMessage({
        messageId: "attachment-only",
        dedupeKey: "attachment-only",
        parts: [
          {
            type: "audio",
            attachment: { name: "voice.ogg" },
            transcript: "",
          },
        ],
      }),
      "main",
      "attachment-memory",
    );

    assert.equal(await scheduler.processOnce(), true);
    assert.equal(observed?.prompt, "");
    assert.ok(observed?.memoryContext.some((entry) => entry.includes("回答保持简洁")));
  } finally {
    await scheduler.stop();
    await fixture.cleanup();
  }
});

function makeTaskDue(store: Awaited<ReturnType<typeof testStore>>["store"], taskId: string): void {
  store.run(
    "UPDATE tasks SET next_attempt_at = ? WHERE id = ?",
    new Date(Date.now() - 1_000).toISOString(),
    taskId,
  );
}

test("scheduler retries safe work twice, preserves FIFO, then stops at three attempts", async () => {
  const { fixture, scheduler } = await schedulerFixture(
    fakeDriver(async () => [
      {
        type: "error",
        error: new IMGentError("AGENT_UNAVAILABLE").descriptor,
      },
    ]),
  );
  try {
    const first = fixture.store.ingest(
      directMessage({ messageId: "retry-first", dedupeKey: "retry-first" }),
      "main",
      "retry-fifo",
    );
    const second = fixture.store.ingest(
      directMessage({ messageId: "retry-second", dedupeKey: "retry-second" }),
      "main",
      "retry-fifo",
    );

    assert.equal(await scheduler.processOnce(), true);
    assert.equal(fixture.store.task(first.taskId!)?.status, "retry_wait");
    assert.equal(fixture.store.task(first.taskId!)?.attempt, 1);
    assert.equal(fixture.store.claimNextTask(), undefined);
    assert.equal(fixture.store.task(second.taskId!)?.status, "queued");

    makeTaskDue(fixture.store, first.taskId!);
    assert.equal(await scheduler.processOnce(), true);
    assert.equal(fixture.store.task(first.taskId!)?.attempt, 2);
    assert.equal(fixture.store.task(first.taskId!)?.status, "retry_wait");

    makeTaskDue(fixture.store, first.taskId!);
    assert.equal(await scheduler.processOnce(), true);
    const exhausted = fixture.store.task(first.taskId!)!;
    assert.equal(exhausted.status, "failed");
    assert.equal(exhausted.attempt, 3);
    assert.equal(exhausted.error?.code, "TASK_RETRY_EXHAUSTED");
    assert.match(
      fixture.store.get<{ payload_json: string }>(
        "SELECT payload_json FROM outbound_messages WHERE task_id = ?",
        first.taskId!,
      )?.payload_json ?? "",
      /\[IMGent: 错误\]/,
    );

    assert.equal(await scheduler.processOnce(), true);
    assert.equal(fixture.store.task(second.taskId!)?.status, "retry_wait");
  } finally {
    await scheduler.stop();
    await fixture.cleanup();
  }
});

test("scheduler never replays unknown or dangerous side effects", async () => {
  const { fixture, scheduler } = await schedulerFixture(
    fakeDriver(async () => [
      {
        type: "error",
        error: new IMGentError("AGENT_TURN_FAILED").descriptor,
      },
    ]),
  );
  try {
    const uncertain = fixture.store.ingest(
      directMessage({ messageId: "uncertain", dedupeKey: "uncertain" }),
      "main",
      "uncertain",
    );
    assert.equal(await scheduler.processOnce(), true);
    assert.equal(fixture.store.task(uncertain.taskId!)?.status, "dead_letter");
    assert.equal(fixture.store.task(uncertain.taskId!)?.error?.code, "TASK_UNSAFE_REPLAY");

    const dangerous = fixture.store.ingest(
      directMessage({ messageId: "dangerous", dedupeKey: "dangerous" }),
      "main",
      "dangerous",
    );
    fixture.store.markDangerousSideEffect(dangerous.taskId!);
    assert.equal(await scheduler.processOnce(), true);
    assert.equal(fixture.store.task(dangerous.taskId!)?.status, "dead_letter");
    assert.equal(
      fixture.store.get<{ count: number }>(
        "SELECT count(*) AS count FROM dead_letters WHERE category = 'task.unsafe-replay'",
      )?.count,
      2,
    );
  } finally {
    await scheduler.stop();
    await fixture.cleanup();
  }
});

test("approval state becomes terminal only after the live driver accepts the answer", async () => {
  let attempts = 0;
  const driver = fakeDriver(async () => []);
  driver.answerRequest = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient delivery failure");
  };
  const { fixture, scheduler } = await schedulerFixture(driver);
  try {
    const ingested = fixture.store.ingest(
      directMessage({ messageId: "approval", dedupeKey: "approval" }),
      "main",
      "approval-conversation",
    );
    const task = fixture.store.claimNextTask();
    assert.equal(task?.id, ingested.taskId);
    new ApprovalService(fixture.store).create(
      task!.id,
      "approval-conversation",
      ingested.principalId,
      {
        requestId: "approval-delivery",
        toolName: "shell",
        sanitizedInput: { command: "pwd" },
        risk: "high",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    await assert.rejects(
      scheduler.answerRequest(
        "approval-delivery",
        ingested.principalId,
        { decision: "allow" },
        "approval-conversation",
      ),
      /transient delivery failure/u,
    );
    assert.equal(
      fixture.store.get<{ status: string }>(
        "SELECT status FROM approvals WHERE request_id = ?",
        "approval-delivery",
      )?.status,
      "pending",
    );
    assert.equal(fixture.store.task(task!.id)?.status, "waiting_approval");

    const delivered = await scheduler.answerRequest(
      "approval-delivery",
      ingested.principalId,
      { decision: "allow" },
      "approval-conversation",
    );
    assert.equal(delivered.status, "allowed");
    assert.equal(delivered.changed, true);
    assert.equal(fixture.store.task(task!.id)?.status, "active");
  } finally {
    await scheduler.stop();
    await fixture.cleanup();
  }
});

test("missing driver terminal becomes a retryable protocol error and retry_wait can be cancelled", async () => {
  const { fixture, scheduler } = await schedulerFixture(
    fakeDriver(async () => [{ type: "output-final", text: "partial" }]),
  );
  try {
    const ingested = fixture.store.ingest(
      directMessage({ messageId: "incomplete", dedupeKey: "incomplete" }),
      "main",
      "protocol",
    );
    assert.equal(await scheduler.processOnce(), true);
    const task = fixture.store.task(ingested.taskId!)!;
    assert.equal(task.status, "retry_wait");
    assert.equal(task.error?.code, "DRIVER_PROTOCOL_INCOMPLETE");
    const cancelled = await scheduler.cancelConversation("protocol", ingested.principalId);
    assert.deepEqual(cancelled, { active: 0, queued: 1 });
    assert.equal(fixture.store.task(ingested.taskId!)?.status, "cancelled");
  } finally {
    await scheduler.stop();
    await fixture.cleanup();
  }
});

function steeredDriver(result: "accepted" | "not-active" | "uncertain" = "accepted") {
  const start = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const releaseSteer = Promise.withResolvers<void>();
  const inputs: Array<{ turnId: string; input: AgentSteerInput }> = [];
  const driver: AgentDriver = {
    ...fakeDriver(async () => []),
    async *runTurn() {
      await start.promise;
      yield { type: "session", sessionId: "same-thread" };
      yield { type: "turn-started" };
      await finish.promise;
      yield { type: "output-final", text: "combined answer" };
      yield { type: "completed", result: "success" };
    },
    async steerTurn(turnId, input) {
      inputs.push({ turnId, input });
      received.resolve();
      await releaseSteer.promise;
      if (result === "uncertain") throw new Error("transport failed after write");
      return result;
    },
  };
  return { driver, start, finish, received, releaseSteer, inputs };
}

test("follow-ups during startup steer the same turn, preserve image input and finish atomically with the latest reply context", async () => {
  const fake = steeredDriver();
  const { fixture, scheduler } = await schedulerFixture(fake.driver, undefined, true);
  const first = fixture.store.ingest(directMessage(), "main", "steering");
  const running = scheduler.processOnce();
  try {
    const second = fixture.store.ingest(
      directMessage({
        messageId: "second",
        parts: [
          { type: "text", text: "use this image instead" },
          { type: "image", attachment: { localPath: "/tmp/input.png" } },
        ],
        replyContext: { opaque: { contextToken: "new-token" } },
      }),
      "main",
      "steering",
    );
    assert.equal(scheduler.onTaskQueued(second.taskId!), true);
    assert.equal(fake.inputs.length, 0);
    fake.start.resolve();
    await fake.received.promise;
    assert.equal(fake.inputs[0]?.turnId, first.taskId);
    assert.equal(fake.inputs[0]?.input.messageId, second.taskId);
    assert.equal(fake.inputs[0]?.input.parts[1]?.type, "image");
    assert.equal(fixture.store.task(second.taskId!)?.status, "active");
    // turn/completed may arrive before the steer response. Do not commit early.
    fake.finish.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.store.task(first.taskId!)?.status, "active");
    fake.releaseSteer.resolve();
    await running;
    for (const id of [first.taskId, second.taskId])
      assert.equal(fixture.store.task(id!)?.status, "succeeded");
    assert.equal(fixture.store.steeredInputs(first.taskId!)[0]?.id, second.taskId);
    const outputs = fixture.store.all<{ payload_json: string; reply_context_cipher: Uint8Array }>(
      "SELECT payload_json, reply_context_cipher FROM outbound_messages",
    );
    assert.equal(outputs.length, 1);
    assert.equal(JSON.parse(outputs[0]!.payload_json).replyTo.messageId, "second");
    assert.equal(
      fixture.store.decryptReplyContext(outputs[0]!.reply_context_cipher)?.opaque.contextToken,
      "new-token",
    );
    assert.equal(fixture.store.all("SELECT * FROM memory_outbox").length, 1);
    assert.equal(fixture.store.session("steering")?.sessionId, "same-thread");
    assert.equal(
      fixture.store.ingest(directMessage({ messageId: "second" }), "main", "steering").duplicate,
      true,
    );
  } finally {
    fake.start.resolve();
    fake.finish.resolve();
    fake.releaseSteer.resolve();
    await running;
    await scheduler.stop();
    await fixture.cleanup();
  }
});

for (const result of ["not-active", "uncertain"] as const) {
  test(`steering ${result} uses a safe, durable fallback`, async () => {
    const fake = steeredDriver(result);
    const { fixture, scheduler } = await schedulerFixture(fake.driver);
    const first = fixture.store.ingest(directMessage(), "main", "steering");
    const running = scheduler.processOnce();
    try {
      const second = fixture.store.ingest(
        directMessage({ messageId: "followup" }),
        "main",
        "steering",
      );
      assert.equal(scheduler.onTaskQueued(second.taskId!), true);
      fake.start.resolve();
      await fake.received.promise;
      fake.releaseSteer.resolve();
      fake.finish.resolve();
      await running;
      assert.equal(fixture.store.task(first.taskId!)?.status, "succeeded");
      assert.equal(
        fixture.store.task(second.taskId!)?.status,
        result === "not-active" ? "queued" : "dead_letter",
      );
      assert.equal(
        fixture.store.get<{ state: string }>(
          "SELECT state FROM task_steers WHERE input_task_id = ?",
          second.taskId!,
        )?.state,
        result === "not-active" ? "rejected" : "uncertain",
      );
      assert.equal(
        fixture.store.task(second.taskId!)?.dangerousSideEffectStarted,
        result === "uncertain",
      );
      assert.equal(
        fixture.store.all("SELECT * FROM outbound_messages").length,
        result === "uncertain" ? 2 : 1,
      );
    } finally {
      fake.start.resolve();
      fake.finish.resolve();
      fake.releaseSteer.resolve();
      await running;
      await scheduler.stop();
      await fixture.cleanup();
    }
  });
}

for (const mode of ["queue", "different-speaker", "unsupported"] as const) {
  test(`follow-up ${mode} preserves FIFO without steering`, async () => {
    const fake = steeredDriver();
    if (mode === "unsupported") delete fake.driver.steerTurn;
    const { fixture, scheduler } = await schedulerFixture(
      fake.driver,
      undefined,
      false,
      mode === "queue" ? "queue" : undefined,
    );
    fixture.store.ingest(directMessage(), "main", "steering");
    const running = scheduler.processOnce();
    try {
      const second = fixture.store.ingest(
        directMessage({
          messageId: "followup",
          ...(mode === "different-speaker" ? { actor: { platformUserId: "someone-else" } } : {}),
        }),
        "main",
        "steering",
      );
      assert.equal(scheduler.onTaskQueued(second.taskId!), false);
      fake.start.resolve();
      fake.finish.resolve();
      await running;
      assert.equal(fake.inputs.length, 0);
      assert.equal(fixture.store.task(second.taskId!)?.status, "queued");
    } finally {
      fake.start.resolve();
      fake.finish.resolve();
      fake.releaseSteer.resolve();
      await running;
      await scheduler.stop();
      await fixture.cleanup();
    }
  });
}

test("an interrupted process does not replay a steer with unknown acceptance", async () => {
  const fixture = await testStore();
  try {
    const first = fixture.store.ingest(directMessage(), "main", "steering");
    fixture.store.claimNextTask();
    const second = fixture.store.ingest(
      directMessage({ messageId: "followup" }),
      "main",
      "steering",
    );
    assert.equal(fixture.store.beginSteer(second.taskId!, first.taskId!), true);
    assert.deepEqual(fixture.store.recoverAfterRestart(), { requeued: 0, deadLettered: 2 });
    assert.equal(
      fixture.store.get<{ state: string }>("SELECT state FROM task_steers")?.state,
      "uncertain",
    );
    assert.equal(fixture.store.claimNextTask(), undefined);
    assert.equal(fixture.store.all("SELECT * FROM inbound_events").length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("cancelling a steered turn settles all inputs without a spurious failure reply", async () => {
  const fake = steeredDriver();
  const originalRun = fake.driver.runTurn;
  fake.driver.runTurn = async function* (input) {
    for await (const event of originalRun(input)) {
      yield event.type === "completed" ? { type: "completed", result: "cancelled" } : event;
    }
  };
  fake.driver.interrupt = async () => {
    fake.finish.resolve();
  };
  const { fixture, scheduler } = await schedulerFixture(fake.driver);
  const first = fixture.store.ingest(directMessage(), "main", "steering");
  const running = scheduler.processOnce();
  try {
    const second = fixture.store.ingest(
      directMessage({ messageId: "followup" }),
      "main",
      "steering",
    );
    scheduler.onTaskQueued(second.taskId!);
    fake.start.resolve();
    await fake.received.promise;
    fake.releaseSteer.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await scheduler.cancelConversation("steering", fixture.store.task(first.taskId!)!.principalId);
    await running;
    for (const id of [first.taskId, second.taskId])
      assert.equal(fixture.store.task(id!)?.status, "cancelled");
    assert.deepEqual(fixture.store.all("SELECT * FROM outbound_messages"), []);
  } finally {
    fake.start.resolve();
    fake.finish.resolve();
    fake.releaseSteer.resolve();
    await running;
    await scheduler.stop();
    await fixture.cleanup();
  }
});
