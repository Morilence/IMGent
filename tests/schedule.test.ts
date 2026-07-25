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
import {
  parseCreateScheduleInput,
  parseUpdateScheduleInput,
  ScheduleService,
} from "../src/schedule/service.js";
import { SkillHostTools } from "../src/skills/host-tools.js";
import { builtInSkillsDirectory } from "../src/skills/paths.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { directMessage, testStore } from "./helpers.js";
import type {
  AdapterReadiness,
  AgentDriver,
  AgentProfile,
  AgentRequestAnswer,
  AgentTurnInput,
  DriverReadiness,
  ImAdapter,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from "@imgent/contracts";

function adapter(sent: OutboundMessage[], proactive = true): ImAdapter {
  return {
    id: proactive ? "qq" : "wechat-ilink",
    capabilities: {
      conversationKinds: ["direct"],
      groupIngestion: "none",
      threads: false,
      inboundTransport: proactive ? "websocket" : "long-polling",
      requiresReplyContext: !proactive,
      supportsProactiveSend: proactive,
    },
    checkReady: async (): Promise<AdapterReadiness> => ({ ready: true, issues: [] }),
    start: async (
      _onMessage: (
        message: InboundMessage,
        checkpoint?: { key: string; value: string },
      ) => Promise<void>,
    ) => undefined,
    stop: async () => undefined,
    send: async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      return { platformMessageId: "scheduled-message", mode: "proactive" };
    },
  };
}

function driver(inspect: (input: AgentTurnInput) => void): AgentDriver {
  return {
    id: "codex",
    checkReady: async (): Promise<DriverReadiness> => ({ ready: true, issues: [] }),
    async *runTurn(input: AgentTurnInput) {
      inspect(input);
      yield { type: "session" as const, sessionId: "scheduled-session" };
      yield { type: "output-final" as const, text: "计划执行完成" };
      yield { type: "completed" as const, result: "success" as const };
    },
    answerRequest: async (_id: string, _answer: AgentRequestAnswer) => undefined,
    interrupt: async (_id: string) => undefined,
  };
}

test("schedule request schemas reject unknown fields and empty updates", () => {
  assert.throws(
    () =>
      parseCreateScheduleInput({
        name: "report",
        prompt: "检查项目状态",
        conversationSpaceId: "conversation-1",
        at: new Date(Date.now() + 60_000).toISOString(),
        unknown: true,
      }),
    (error: unknown) => error instanceof IMGentError && error.code === "CLI_USAGE_INVALID",
  );
  assert.throws(
    () => parseUpdateScheduleInput({}),
    (error: unknown) => error instanceof IMGentError && error.code === "CLI_USAGE_INVALID",
  );
  assert.throws(
    () => parseUpdateScheduleInput({ conversationSpaceId: "conversation-2" }),
    (error: unknown) => error instanceof IMGentError && error.code === "CLI_USAGE_INVALID",
  );
  assert.deepEqual(parseUpdateScheduleInput({ contextMode: "series" }), {
    contextMode: "series",
  });
});

test("scheduled turns use proactive delivery and isolate fresh sessions", async () => {
  const fixture = await testStore();
  try {
    const seeded = fixture.store.ingest(
      directMessage({ messageId: "schedule-seed", dedupeKey: "schedule-seed" }),
      "main",
      "main:qq:qq-main:direct:user-1",
      undefined,
      false,
    );
    fixture.store.run(
      "UPDATE platform_identities SET paired = 1 WHERE id = ?",
      seeded.platformIdentityId,
    );
    const sent: OutboundMessage[] = [];
    const qq = adapter(sent);
    const service = new ScheduleService(fixture.store, new Map([["qq-main", qq]]));
    const scheduledFor = new Date(Date.now() + 60_000);
    const schedule = service.create({
      name: "daily-report",
      prompt: "检查项目状态",
      conversationSpaceId: seeded.conversationSpaceId,
      at: scheduledFor.toISOString(),
    });
    assert.equal(schedule.contextMode, "fresh");
    assert.equal(service.processDue(new Date(scheduledFor.valueOf() + 1)), true);
    assert.equal(service.processDue(new Date(scheduledFor.valueOf() + 1)), false);

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
      memory: { enabled: true },
    };
    let observed: AgentTurnInput | undefined;
    const outbound = new OutboundDispatcher(fixture.store);
    const scheduler = new ConversationScheduler({
      store: fixture.store,
      profiles: new Map([["main", profile]]),
      drivers: new Map([["main", driver((input) => (observed = input))]]),
      adapters: new Map([["qq-main", qq]]),
      approvals: new ApprovalService(fixture.store),
      memory,
      hostTools,
      skills,
      outbound,
    });
    assert.equal(await scheduler.processOnce(), true);
    await outbound.drain(new Map([["qq-main", qq]]));

    assert.equal(observed?.ephemeral, true);
    assert.equal(observed?.sessionId, undefined);
    assert.match(observed?.developerInstructions ?? "", /IMGent scheduled execution/);
    assert.equal(fixture.store.session(`schedule:${schedule.id}`), undefined);
    assert.equal(
      fixture.store.get<{ count: number }>("SELECT count(*) AS count FROM memory_outbox")?.count,
      0,
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.replyTo, undefined);
    assert.equal(sent[0]?.replyContext, undefined);
    assert.match(
      sent[0]?.parts[0]?.type === "text" ? sent[0].parts[0].text : "",
      /\[定时任务：daily-report\]/,
    );
    assert.equal(service.history(schedule.id).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("series schedules get a dedicated session and unsupported delivery is rejected", async () => {
  const fixture = await testStore();
  try {
    const seeded = fixture.store.ingest(
      directMessage({ messageId: "series-seed", dedupeKey: "series-seed" }),
      "main",
      "main:qq:qq-main:direct:user-1",
      undefined,
      false,
    );
    fixture.store.run(
      "UPDATE platform_identities SET paired = 1 WHERE id = ?",
      seeded.platformIdentityId,
    );
    const service = new ScheduleService(fixture.store, new Map([["qq-main", adapter([], true)]]));
    const schedule = service.create({
      name: "monitor",
      prompt: "检查变化",
      conversationSpaceId: seeded.conversationSpaceId,
      cron: "*/5 * * * *",
      timezone: "Asia/Shanghai",
      contextMode: "series",
    });
    service.trigger(schedule.id);
    const task = fixture.store.claimNextTask();
    assert.equal(task?.sessionKey, `schedule:${schedule.id}`);
    assert.equal(task?.executionKey, `schedule:${schedule.id}`);
    assert.equal(task?.conversationKey, "main:qq:qq-main:direct:user-1");

    const unsupported = new ScheduleService(
      fixture.store,
      new Map([["qq-main", adapter([], false)]]),
    );
    assert.throws(
      () =>
        unsupported.create({
          name: "cannot-deliver",
          prompt: "不会执行",
          conversationSpaceId: seeded.conversationSpaceId,
          at: new Date(Date.now() + 60_000).toISOString(),
        }),
      (error: unknown) =>
        error instanceof IMGentError && error.code === "OUTBOUND_PLATFORM_REJECTED",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("metadata updates preserve schedule state and removed schedules retain queryable history", async () => {
  const fixture = await testStore();
  try {
    const seeded = fixture.store.ingest(
      directMessage({ messageId: "update-seed", dedupeKey: "update-seed" }),
      "main",
      "main:qq:qq-main:direct:user-1",
      undefined,
      false,
    );
    fixture.store.run(
      "UPDATE platform_identities SET paired = 1 WHERE id = ?",
      seeded.platformIdentityId,
    );
    const service = new ScheduleService(fixture.store, new Map([["qq-main", adapter([], true)]]));
    const paused = service.create({
      name: "paused-report",
      prompt: "检查状态",
      conversationSpaceId: seeded.conversationSpaceId,
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
    });
    service.setStatus(paused.id, "paused");
    const renamed = service.update(paused.id, { name: "renamed-report" });
    assert.equal(renamed.status, "paused");

    const scheduledFor = new Date(Date.now() + 60_000);
    const once = service.create({
      name: "one-time-report",
      prompt: "检查一次",
      conversationSpaceId: seeded.conversationSpaceId,
      at: scheduledFor.toISOString(),
    });
    assert.equal(service.processDue(new Date(scheduledFor.valueOf() + 1)), true);
    const completed = service.update(once.id, { prompt: "更新提示但不重新运行" });
    assert.equal(completed.status, "completed");
    assert.equal(completed.nextRunAt, undefined);

    const rescheduled = service.update(once.id, {
      at: new Date(Date.now() + 120_000).toISOString(),
    });
    assert.equal(rescheduled.status, "active");
    assert.ok(rescheduled.nextRunAt);

    service.remove(once.id);
    assert.equal(service.history(once.id).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("cron catch-up coalesces missed times and overlap is counted without backlog", async () => {
  const fixture = await testStore();
  try {
    const seeded = fixture.store.ingest(
      directMessage({ messageId: "cron-seed", dedupeKey: "cron-seed" }),
      "main",
      "main:qq:qq-main:direct:user-1",
      undefined,
      false,
    );
    fixture.store.run(
      "UPDATE platform_identities SET paired = 1 WHERE id = ?",
      seeded.platformIdentityId,
    );
    const service = new ScheduleService(fixture.store, new Map([["qq-main", adapter([], true)]]));
    const schedule = service.create({
      name: "minute-check",
      prompt: "检查一次",
      conversationSpaceId: seeded.conversationSpaceId,
      cron: "* * * * *",
      timezone: "Asia/Shanghai",
    });
    const reference = new Date();
    fixture.store.run(
      "UPDATE schedules SET next_run_at = ? WHERE id = ?",
      new Date(reference.valueOf() - 60 * 60_000).toISOString(),
      schedule.id,
    );
    assert.equal(service.processDue(reference), true);
    const history = service.history(schedule.id) as Array<{ scheduledFor: string }>;
    assert.equal(history.length, 1);
    assert.ok(reference.valueOf() - Date.parse(history[0]!.scheduledFor) <= 60_000);

    fixture.store.run(
      "UPDATE schedules SET next_run_at = ? WHERE id = ?",
      new Date(reference.valueOf() - 1_000).toISOString(),
      schedule.id,
    );
    assert.equal(service.processDue(reference), true);
    assert.equal(service.history(schedule.id).length, 1);
    assert.equal(service.require(schedule.id).skippedRunCount, 1);

    assert.throws(
      () =>
        service.create({
          name: "seconds-not-supported",
          prompt: "invalid",
          conversationSpaceId: seeded.conversationSpaceId,
          cron: "* * * * * *",
          timezone: "Asia/Shanghai",
        }),
      (error: unknown) => error instanceof IMGentError && error.code === "CLI_USAGE_INVALID",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("cron runs at an exact minute use that minute as the scheduled occurrence", async () => {
  const fixture = await testStore();
  try {
    const seeded = fixture.store.ingest(
      directMessage({ messageId: "boundary-seed", dedupeKey: "boundary-seed" }),
      "main",
      "main:qq:qq-main:direct:user-1",
      undefined,
      false,
    );
    fixture.store.run(
      "UPDATE platform_identities SET paired = 1 WHERE id = ?",
      seeded.platformIdentityId,
    );
    const service = new ScheduleService(fixture.store, new Map([["qq-main", adapter([], true)]]));
    const schedule = service.create({
      name: "boundary-check",
      prompt: "检查边界",
      conversationSpaceId: seeded.conversationSpaceId,
      cron: "* * * * *",
      timezone: "UTC",
    });
    const reference = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60_000);
    fixture.store.run(
      "UPDATE schedules SET next_run_at = ? WHERE id = ?",
      reference.toISOString(),
      schedule.id,
    );

    assert.equal(service.processDue(reference), true);
    const history = service.history(schedule.id) as Array<{ scheduledFor: string }>;
    assert.equal(history[0]?.scheduledFor, reference.toISOString());
  } finally {
    await fixture.cleanup();
  }
});
