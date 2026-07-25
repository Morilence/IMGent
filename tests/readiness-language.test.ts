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

function capturingAdapter(
  sent: OutboundMessage[],
  conversationKinds: ImAdapter["capabilities"]["conversationKinds"] = ["direct", "group"],
): ImAdapter {
  return {
    id: conversationKinds.includes("group") ? "qq" : "wechat-ilink",
    capabilities: {
      conversationKinds,
      groupIngestion: conversationKinds.includes("group") ? "triggered" : "none",
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
          agentUserHome: directory,
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
        messageId: "unauthorized-group",
        dedupeKey: "unauthorized-group",
        eventId: "unauthorized-group-event",
        conversation: { kind: "group", platformConversationId: "group-1" },
        actor: { platformUserId: "user-1", displayName: "User", role: "member" },
      }),
    );
    const groupGuidance = JSON.stringify(sent.at(-1));
    assert.match(groupGuidance, /\[IMGent: 群授权\]/);
    assert.match(groupGuidance, /私聊机器人/);
    assert.match(groupGuidance, /imgent pair <配对码>/);
    assert.match(groupGuidance, /nextSteps/);
    assert.match(groupGuidance, /请勿在群聊中发送配对码/);

    await application.handleInbound(
      directMessage({
        messageId: "unpaired-direct",
        dedupeKey: "unpaired-direct",
        eventId: "unpaired-direct-event",
      }),
    );
    const directGuidance = JSON.stringify(sent.at(-1));
    assert.match(directGuidance, /\[IMGent: 配对\]/);
    assert.match(directGuidance, /imgent pair [A-F0-9]{10}/);
    assert.match(directGuidance, /CLI 会列出待授权群及下一条命令/);

    application.adapters.set("qq-main", capturingAdapter(sent, ["direct"]));
    await application.handleInbound(
      directMessage({
        platform: "wechat-ilink",
        messageId: "unpaired-wechat",
        dedupeKey: "unpaired-wechat",
        eventId: "unpaired-wechat-event",
        conversation: { kind: "direct", platformConversationId: "wechat-user" },
        actor: { platformUserId: "wechat-user", displayName: "WeChat User" },
      }),
    );
    const wechatGuidance = JSON.stringify(sent.at(-1));
    assert.match(wechatGuidance, /\[IMGent: 配对\]/);
    assert.match(wechatGuidance, /请勿转发配对码/);
    assert.doesNotMatch(wechatGuidance, /群聊|待授权群/);

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
      /\[IMGent: System\].*Errors and diagnostics will use English/,
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
    assert.match(latest?.payload_json ?? "", /\[IMGent: Error\].*language is not supported/i);
    assert.doesNotMatch(latest?.payload_json ?? "", /fr-FR|raw|diagnostic/);
  } finally {
    await application?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
