import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/index.js";
import { writeConfig } from "../src/config/write.js";
import { CredentialStore } from "../src/security/credential-store.js";
import { IMGentApplication } from "../src/service/application.js";
import { IMGentService } from "../src/service/lifecycle.js";
import { directMessage } from "./helpers.js";
import type {
  AdapterReadiness,
  ImAdapter,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from "@imgent/contracts";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function capturingAdapter(sent: OutboundMessage[]): ImAdapter {
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
    send: async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      return { platformMessageId: `sent-${sent.length}`, mode: "reply" };
    },
  };
}

test("/healthz stays simple and /readyz localizes issues from Accept-Language", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-readyz-"));
  let service: IMGentService | undefined;
  try {
    const port = await availablePort();
    const configPath = join(directory, "imgent.json");
    await writeConfig(configPath, {
      ...defaultConfig(directory),
      dataDir: "./state",
      server: { host: "127.0.0.1", port },
    });
    service = await IMGentService.start(configPath);

    const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(health.status, "ok");
    assert.equal(health.started, true);
    assert.equal("issues" in health, false);

    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      headers: { "Accept-Language": "fr-FR, en-US;q=0.9, zh-CN;q=0.8" },
    });
    assert.equal(response.status, 503);
    const readiness = (await response.json()) as {
      ready: boolean;
      checkedAt: string;
      depth: string;
      locale: string;
      issues: Array<{ code: string; message: string; action?: string }>;
    };
    assert.equal(readiness.ready, false);
    assert.equal(readiness.depth, "runtime");
    assert.equal(readiness.locale, "en-US");
    assert.equal(readiness.issues[0]?.code, "PROFILE_OR_DRIVER_MISSING");
    assert.match(readiness.issues[0]?.message ?? "", /AgentProfile|Driver/);
    assert.ok(readiness.issues[0]?.action);
    const repeated = (await (await fetch(`http://127.0.0.1:${port}/readyz`)).json()) as {
      checkedAt: string;
    };
    assert.equal(repeated.checkedAt, readiness.checkedAt);
  } finally {
    await service?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unpaired users can set a Principal language and receive localized command errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-language-"));
  let application: IMGentApplication | undefined;
  try {
    const dataDirectory = join(directory, "state");
    const configPath = join(directory, "imgent.json");
    const config = defaultConfig(directory);
    await writeConfig(configPath, {
      ...config,
      dataDir: "./state",
      agentProfiles: [
        {
          id: "main",
          driver: "codex",
          command: "codex",
          workspace: directory,
          skills: ["*"],
          permissions: { maxMode: "ask" },
          memory: { enabled: false },
        },
      ],
      bots: [
        {
          id: "qq-main",
          adapter: "qq",
          transport: "websocket",
          platformBotId: "app-id",
          credentialRef: "qq-main",
          groupIngestionDefault: "triggered",
          enabled: true,
        },
      ],
      routes: [{ botInstanceId: "qq-main", agentProfileId: "main" }],
    });
    await new CredentialStore(dataDirectory).set("qq-main", {
      appSecret: "local-test-secret",
    });
    application = await IMGentApplication.create(configPath);
    const sent: OutboundMessage[] = [];
    application.adapters.set("qq-main", capturingAdapter(sent));

    await application.handleInbound(
      directMessage({
        messageId: "language-en",
        dedupeKey: "language-en",
        eventId: "language-en-event",
        parts: [{ type: "text", text: "/imgent language en-US" }],
      }),
    );
    const principal = application.store.get<{
      principal_id: string;
      paired: number;
      locale: string | null;
    }>(
      `SELECT pi.principal_id, pi.paired, p.locale
       FROM platform_identities pi
       JOIN principals p ON p.id = pi.principal_id
       WHERE pi.platform_user_id = 'user-1'`,
    );
    assert.equal(principal?.paired, 0);
    assert.equal(principal?.locale, "en-US");
    assert.match(
      JSON.stringify(
        application.store.get<{ payload_json: string }>(
          `SELECT payload_json FROM outbound_messages
           WHERE idempotency_key LIKE 'command:%'
           ORDER BY created_at DESC LIMIT 1`,
        ),
      ),
      /Errors and diagnostics will use English/,
    );

    await application.handleInbound(
      directMessage({
        messageId: "language-invalid",
        dedupeKey: "language-invalid",
        eventId: "language-invalid-event",
        parts: [{ type: "text", text: "/imgent language fr-FR" }],
      }),
    );
    const latest = application.store.get<{ payload_json: string }>(
      `SELECT payload_json FROM outbound_messages
       WHERE idempotency_key LIKE 'command:%'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    );
    assert.match(latest?.payload_json ?? "", /language is not supported/i);
    assert.doesNotMatch(latest?.payload_json ?? "", /fr-FR|raw|diagnostic/);
  } finally {
    await application?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
