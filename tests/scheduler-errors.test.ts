import assert from "node:assert/strict";
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

async function schedulerFixture(driver: AgentDriver): Promise<{
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
    workspace: fixture.directory,
    skills: ["*"],
    permissions: { maxMode: "ask" },
    memory: { enabled: false },
  };
  const outbound = new OutboundDispatcher(fixture.store);
  const scheduler = new ConversationScheduler({
    store: fixture.store,
    profiles: new Map([["main", profile]]),
    drivers: new Map([["main", driver]]),
    adapters: new Map([["qq-main", fakeAdapter()]]),
    approvals: new ApprovalService(fixture.store),
    memory,
    hostTools,
    skills,
    outbound,
  });
  return { fixture, scheduler };
}

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
