import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IMGentError } from "@imgent/contracts";
import { defaultConfig } from "../src/config/index.js";
import { writeConfig } from "../src/config/write.js";
import { CredentialStore } from "../src/security/credential-store.js";
import { AdminService } from "../src/service/admin-service.js";
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
  ready = true,
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
    checkReady: async (): Promise<AdapterReadiness> => ({ ready, issues: [] }),
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

async function waitForOutbound(
  sent: OutboundMessage[],
  predicate: (message: OutboundMessage) => boolean,
): Promise<OutboundMessage> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = sent.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for outbound message");
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
    const proactivePairing = await waitForOutbound(
      sent,
      (message) =>
        message.conversation.kind === "direct" &&
        JSON.stringify(message).includes("排队中的群授权码"),
    );
    const proactivePairingText = JSON.stringify(proactivePairing);
    assert.match(proactivePairingText, /\[IMGent: 配对\]/);
    assert.match(proactivePairingText, /imgent pair [A-F0-9]{10}/);
    assert.equal(proactivePairing.conversation.platformConversationId, "user-1");
    assert.equal(proactivePairing.replyTo, undefined);
    const groupPairingCode = proactivePairingText.match(/imgent pair ([A-F0-9]{10})/)?.[1];
    assert.ok(groupPairingCode);

    const groupGuidance = JSON.stringify(
      await waitForOutbound(sent, (message) => message.conversation.kind === "group"),
    );
    assert.match(groupGuidance, /\[IMGent: 群授权\]/);
    assert.match(groupGuidance, /配对指引已发送到发起人的私聊/);
    assert.match(groupGuidance, /配对完成后会自动续发群授权码/);
    assert.doesNotMatch(groupGuidance, /imgent pair|当前群空间 ID|nextSteps/);

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

    application.adapters.set("qq-main", capturingAdapter(sent));
    const admin = new AdminService(application);
    const paired = (await admin.confirmPairing(groupPairingCode)) as {
      principalId: string;
      nextSteps: Array<{
        action: string;
        authorizationCode: string;
        command: string;
        conversationSpaceId: string;
      }>;
    };
    assert.equal(paired.principalId, principal?.principal_id);
    assert.equal(paired.nextSteps.length, 1);
    assert.match(paired.nextSteps[0]!.authorizationCode, /^GRP-[A-F0-9]{12}$/);
    assert.equal(paired.nextSteps[0]!.action, "authorize-group");
    assert.match(
      paired.nextSteps[0]!.command,
      new RegExp(
        `^imgent group authorize-code ${paired.nextSteps[0]!.authorizationCode} --principal principal_`,
      ),
    );
    const authorizationGuidance = JSON.stringify(
      await waitForOutbound(
        sent,
        (message) =>
          message.conversation.kind === "direct" &&
          JSON.stringify(message).includes("[IMGent: Group authorization]"),
      ),
    );
    assert.match(authorizationGuidance, /Group authorization code: GRP-[A-F0-9]{12}/);
    assert.match(authorizationGuidance, /imgent group authorize-code/);
    assert.match(authorizationGuidance, /mention the bot in the group again/);
    assert.doesNotMatch(authorizationGuidance, /conversationSpaceId|nextSteps/);

    const firstAuthorizationCode = paired.nextSteps[0]!.authorizationCode;
    const authorized = await admin.authorizeGroup(
      paired.nextSteps[0]!.conversationSpaceId,
      paired.principalId,
    );
    assert.deepEqual(authorized, {
      result: "group-authorized",
      conversationSpaceId: paired.nextSteps[0]!.conversationSpaceId,
      principalId: paired.principalId,
    });
    const authorizedNotice = await waitForOutbound(
      sent,
      (message) =>
        message.conversation.kind === "group" &&
        JSON.stringify(message).includes("This group is now authorized"),
    );
    assert.match(JSON.stringify(authorizedNotice), /^\{.*\[IMGent: Group authorization\]/u);
    assert.equal(authorizedNotice.replyTo, undefined);

    const schedule = await admin.createSchedule({
      name: "hourly-news",
      prompt: "SECRET PROMPT MUST NOT LEAK",
      conversationSpaceId: paired.nextSteps[0]!.conversationSpaceId,
      principalId: paired.principalId,
      cron: "35 * * * *",
      timezone: "Asia/Shanghai",
    });
    const createdNotice = await waitForOutbound(sent, (message) =>
      message.idempotencyKey.includes(`schedule-notice:${schedule.id}:created:`),
    );
    const createdText = JSON.stringify(createdNotice);
    assert.match(createdText, /\[IMGent: Scheduled task\].*Created scheduled task/u);
    assert.match(createdText, /Cron 35 \* \* \* \*/u);
    assert.match(createdText, /Asia\/Shanghai/u);
    assert.doesNotMatch(createdText, /SECRET PROMPT MUST NOT LEAK/u);

    const updated = await admin.updateSchedule(schedule.id, {
      name: "hourly-briefing",
      prompt: "ANOTHER SECRET PROMPT",
    });
    assert.equal(updated.name, "hourly-briefing");
    const updatedText = JSON.stringify(
      await waitForOutbound(sent, (message) =>
        message.idempotencyKey.includes(`schedule-notice:${schedule.id}:updated:`),
      ),
    );
    assert.match(updatedText, /Updated scheduled task.*hourly-briefing/u);
    assert.doesNotMatch(updatedText, /ANOTHER SECRET PROMPT/u);

    await admin.pauseSchedule(schedule.id);
    assert.match(
      JSON.stringify(
        await waitForOutbound(sent, (message) =>
          message.idempotencyKey.includes(`schedule-notice:${schedule.id}:paused:`),
        ),
      ),
      /Paused scheduled task.*Status: Paused/u,
    );
    await admin.resumeSchedule(schedule.id);
    assert.match(
      JSON.stringify(
        await waitForOutbound(sent, (message) =>
          message.idempotencyKey.includes(`schedule-notice:${schedule.id}:resumed:`),
        ),
      ),
      /Resumed scheduled task.*Status: Active/u,
    );

    const rejecting = capturingAdapter(sent);
    rejecting.send = async () => {
      throw new IMGentError("ADAPTER_REQUEST_REJECTED");
    };
    application.adapters.set("qq-main", rejecting);
    const updateDespiteNotificationFailure = await admin.updateSchedule(schedule.id, {
      name: "delivery-independent",
    });
    assert.equal(updateDespiteNotificationFailure.name, "delivery-independent");
    await application.outbound.drain(application.adapters);
    assert.equal(
      application.store.get<{ status: string }>(
        `SELECT status FROM outbound_messages
         WHERE idempotency_key LIKE ?
         ORDER BY created_at DESC LIMIT 1`,
        `schedule-notice:${schedule.id}:updated:%`,
      )?.status,
      "dead_letter",
    );

    application.adapters.set("qq-main", capturingAdapter(sent));
    assert.deepEqual(await admin.removeSchedule(schedule.id), {
      result: "schedule-removed",
      id: schedule.id,
    });
    assert.match(
      JSON.stringify(
        await waitForOutbound(sent, (message) =>
          message.idempotencyKey.includes(`schedule-notice:${schedule.id}:removed:`),
        ),
      ),
      /Removed scheduled task.*Status: Removed/u,
    );

    application.adapters.set("qq-main", capturingAdapter(sent, ["direct", "group"], false));
    const sentBeforeSkipped = sent.length;
    const skippedNoticeSchedule = await admin.createSchedule({
      name: "offline-notice",
      prompt: "do not notify while offline",
      conversationSpaceId: paired.nextSteps[0]!.conversationSpaceId,
      principalId: paired.principalId,
      at: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(sent.length, sentBeforeSkipped);
    assert.equal(
      application.store.get<{ count: number }>(
        `SELECT count(*) AS count FROM audit_events
         WHERE event_type = 'notification.skipped'
           AND details_json LIKE ?`,
        `%"subjectId":"${skippedNoticeSchedule.id}"%`,
      )?.count,
      1,
    );

    application.adapters.set("qq-main", capturingAdapter(sent));
    await application.handleInbound(
      directMessage({
        messageId: "paired-unauthorized-group",
        dedupeKey: "paired-unauthorized-group",
        eventId: "paired-unauthorized-group-event",
        conversation: { kind: "group", platformConversationId: "group-2" },
        actor: { platformUserId: "user-1", displayName: "User", role: "member" },
      }),
    );
    const pairedGroupGuidance = JSON.stringify(
      await waitForOutbound(
        sent,
        (message) =>
          message.conversation.kind === "direct" &&
          JSON.stringify(message).includes("imgent group authorize-code") &&
          !JSON.stringify(message).includes(firstAuthorizationCode),
      ),
    );
    assert.match(pairedGroupGuidance, /Group authorization code: GRP-[A-F0-9]{12}/);
    assert.doesNotMatch(pairedGroupGuidance, /imgent pair/);
    const pairedGroupReply = JSON.stringify(
      await waitForOutbound(
        sent,
        (message) =>
          message.conversation.kind === "group" &&
          message.conversation.platformConversationId === "group-2",
      ),
    );
    assert.match(pairedGroupReply, /group authorization code was sent.*direct messages/i);
  } finally {
    await application?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
