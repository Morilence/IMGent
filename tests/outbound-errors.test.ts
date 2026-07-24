import assert from "node:assert/strict";
import { test } from "node:test";
import { IMGentError } from "@imgent/contracts";
import { OutboundDispatcher } from "../src/runtime/outbound.js";
import { directMessage, testStore } from "./helpers.js";
import type {
  AdapterReadiness,
  ImAdapter,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from "@imgent/contracts";

function outbound(idempotencyKey: string): OutboundMessage {
  return {
    botInstanceId: "qq-main",
    conversation: { kind: "direct", platformConversationId: "user-1" },
    parts: [{ type: "text", text: "safe result" }],
    replyContext: {
      opaque: { messageId: "inbound", contextToken: "short-lived-secret" },
    },
    idempotencyKey,
  };
}

function adapter(send: (message: OutboundMessage) => Promise<SendResult>): ImAdapter {
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
    send,
  };
}

function makeDue(store: Awaited<ReturnType<typeof testStore>>["store"], id: string): void {
  store.run(
    "UPDATE outbound_messages SET next_attempt_at = ? WHERE id = ?",
    new Date(Date.now() - 1_000).toISOString(),
    id,
  );
}

test("outbound honors rate limits and transient retries before succeeding", async () => {
  const fixture = await testStore();
  try {
    const dispatcher = new OutboundDispatcher(fixture.store);
    const id = dispatcher.enqueue(outbound("outbound-retry"));
    let attempts = 0;
    const transient = adapter(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new IMGentError("ADAPTER_RATE_LIMITED", { retryAfterMs: 25 });
      }
      if (attempts === 2) {
        throw new IMGentError("ADAPTER_SERVICE_UNAVAILABLE");
      }
      return { platformMessageId: "sent-3", mode: "reply" };
    });
    const adapters = new Map([["qq-main", transient]]);

    assert.equal(await dispatcher.drain(adapters), 0);
    let row = fixture.store.get<{
      status: string;
      attempt: number;
      next_attempt_at: string;
      last_error_json: string;
    }>(
      `SELECT status, attempt, next_attempt_at, last_error_json
       FROM outbound_messages WHERE id = ?`,
      id,
    );
    assert.equal(row?.status, "retry_wait");
    assert.equal(row?.attempt, 1);
    assert.equal(JSON.parse(row!.last_error_json).code, "OUTBOUND_RATE_LIMITED");

    makeDue(fixture.store, id);
    assert.equal(await dispatcher.drain(adapters), 0);
    row = fixture.store.get(
      `SELECT status, attempt, next_attempt_at, last_error_json
       FROM outbound_messages WHERE id = ?`,
      id,
    );
    assert.equal(row?.status, "retry_wait");
    assert.equal(row?.attempt, 2);

    makeDue(fixture.store, id);
    assert.equal(await dispatcher.drain(adapters), 1);
    const sent = fixture.store.get<{
      status: string;
      attempt: number;
      platform_message_id: string;
    }>("SELECT status, attempt, platform_message_id FROM outbound_messages WHERE id = ?", id);
    assert.deepEqual(
      { ...sent },
      {
        status: "sent",
        attempt: 3,
        platform_message_id: "sent-3",
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("context and ordinary platform rejection do not retry or fail a succeeded task", async () => {
  const fixture = await testStore();
  try {
    const ingested = fixture.store.ingest(
      directMessage({ messageId: "outbound-task", dedupeKey: "outbound-task" }),
      "main",
      "outbound-task",
    );
    const task = fixture.store.claimNextTask()!;
    const message = outbound("outbound-context");
    assert.equal(
      fixture.store.completeTaskWithOutbound(task.id, "agent succeeded", false, message),
      true,
    );
    const dispatcher = new OutboundDispatcher(fixture.store);
    const rejected = adapter(async () => {
      throw new IMGentError("ADAPTER_REPLY_CONTEXT_INVALID", {
        diagnostic: { vendorResponse: "raw vendor context token=super-secret-value" },
      });
    });
    await dispatcher.drain(new Map([["qq-main", rejected]]));

    assert.equal(fixture.store.task(ingested.taskId!)?.status, "succeeded");
    const failed = fixture.store.get<{
      status: string;
      attempt: number;
      last_error_json: string;
    }>(
      `SELECT status, attempt, last_error_json
       FROM outbound_messages WHERE idempotency_key = 'outbound-context'`,
    );
    assert.equal(failed?.status, "dead_letter");
    assert.equal(failed?.attempt, 1);
    assert.equal(JSON.parse(failed!.last_error_json).code, "OUTBOUND_CONTEXT_EXPIRED");
    const deadLetter = fixture.store.get<{
      error_json: string;
      diagnostic_json: string;
    }>(
      `SELECT error_json, diagnostic_json FROM dead_letters
       WHERE category = 'outbound.send'`,
    );
    assert.equal(JSON.parse(deadLetter!.error_json).code, "OUTBOUND_CONTEXT_EXPIRED");
    assert.doesNotMatch(
      `${deadLetter!.error_json}${deadLetter!.diagnostic_json}`,
      /super-secret|raw vendor/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("outbound recovers sending rows after restart and dead-letters after three failures", async () => {
  const fixture = await testStore();
  try {
    const firstDispatcher = new OutboundDispatcher(fixture.store);
    const id = firstDispatcher.enqueue(outbound("outbound-restart"));
    fixture.store.run("UPDATE outbound_messages SET status = 'sending' WHERE id = ?", id);
    const dispatcher = new OutboundDispatcher(fixture.store);
    assert.equal(
      fixture.store.get<{ status: string }>("SELECT status FROM outbound_messages WHERE id = ?", id)
        ?.status,
      "retry_wait",
    );

    const unavailable = adapter(async () => {
      throw new IMGentError("ADAPTER_SERVICE_UNAVAILABLE");
    });
    const adapters = new Map([["qq-main", unavailable]]);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      makeDue(fixture.store, id);
      await dispatcher.drain(adapters);
    }
    const row = fixture.store.get<{ status: string; attempt: number }>(
      "SELECT status, attempt FROM outbound_messages WHERE id = ?",
      id,
    );
    assert.deepEqual({ ...row }, { status: "dead_letter", attempt: 3 });
    assert.equal(
      fixture.store.get<{ count: number }>(
        "SELECT count(*) AS count FROM dead_letters WHERE reference_id = ?",
        id,
      )?.count,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});
