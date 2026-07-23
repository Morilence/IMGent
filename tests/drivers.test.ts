import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeCodeDriver, type ClaudeSdk } from "@agent-pigeon/driver-claude-code";
import { CodexDriver } from "@agent-pigeon/driver-codex";
import type { AgentEvent, AgentProfile, AgentTurnInput } from "@agent-pigeon/contracts";

const profile = (
  driver: "codex" | "claude-code",
  command: string,
  workspace: string,
): AgentProfile => ({
  id: `${driver}-test`,
  driver,
  command,
  workspace,
  permissions: { maxMode: "ask" },
  memory: { enabled: true },
});

const turn = (profileValue: AgentProfile): AgentTurnInput => ({
  turnId: "turn-1",
  conversationKey: "conversation",
  profile: profileValue,
  prompt: "reply",
  parts: [{ type: "text", text: "reply" }],
  memoryContext: [],
});

test("Codex driver speaks app-server JSON-RPC and serves dynamic host tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-pigeon-codex-"));
  const executable = join(directory, "fake-codex.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.145.0\\n");
  process.exit(0);
}
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ id: request.id, result: { userAgent: "fake" } });
  } else if (request.method === "account/read") {
    send({ id: request.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  } else if (request.method === "thread/start") {
    if (!request.params.dynamicTools) process.exit(9);
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  } else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "vendor-turn" } } });
    send({ id: 900, method: "item/tool/call", params: {
      threadId: "thread-1", namespace: "memory", tool: "search",
      arguments: { query: "x" }
    } });
  } else if (request.id === 900 && request.result) {
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-1", turnId: "vendor-turn", delta: "PO"
    } });
    send({ method: "item/completed", params: {
      threadId: "thread-1", turnId: "vendor-turn",
      item: { type: "agentMessage", text: "PONG" }
    } });
    send({ method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "vendor-turn", status: "completed" }
    } });
  }
});`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  let hostCalled = false;
  const driver = new CodexDriver({
    hostTools: [
      {
        namespace: "memory",
        name: "search",
        description: "search",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    hostToolHandler: async () => {
      hostCalled = true;
      return { success: true, text: "[]" };
    },
  });
  try {
    assert.equal((await driver.checkReady(profile("codex", executable, directory))).ready, true);
    const events: AgentEvent[] = [];
    for await (const event of driver.runTurn(turn(profile("codex", executable, directory)))) {
      events.push(event);
    }
    assert.equal(hostCalled, true);
    assert.ok(events.some((event) => event.type === "session" && event.sessionId === "thread-1"));
    assert.ok(events.some((event) => event.type === "output-final" && event.text === "PONG"));
    assert.ok(events.some((event) => event.type === "completed" && event.result === "success"));
  } finally {
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude driver contract streams output and persists the SDK session", async () => {
  const sdk: ClaudeSdk = {
    query: () => {
      const iterable = (async function* () {
        yield {
          type: "assistant",
          session_id: "claude-session",
          message: {
            content: [{ type: "text", text: "CLAUDE" }],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "claude-session",
          result: "CLAUDE",
          terminal_reason: "completed",
        };
      })();
      return Object.assign(iterable, {
        interrupt: async () => undefined,
        close: () => undefined,
      }) as never;
    },
  };
  const driver = new ClaudeCodeDriver({ sdk, probeOnReady: false });
  const events: AgentEvent[] = [];
  for await (const event of driver.runTurn(turn(profile("claude-code", "claude", process.cwd())))) {
    events.push(event);
  }
  assert.ok(
    events.some((event) => event.type === "session" && event.sessionId === "claude-session"),
  );
  assert.ok(events.some((event) => event.type === "output-final" && event.text === "CLAUDE"));
  assert.ok(events.some((event) => event.type === "completed" && event.result === "success"));
  await driver.close();
});
