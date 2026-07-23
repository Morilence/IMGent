import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretBox } from "../src/security/secret-box.js";
import { PigeonStore } from "../src/storage/store.js";
import type { InboundMessage } from "@agent-pigeon/contracts";

export async function testStore(): Promise<{
  directory: string;
  store: PigeonStore;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agent-pigeon-test-"));
  const store = await PigeonStore.open(
    join(directory, "test.sqlite"),
    new SecretBox(randomBytes(32)),
  );
  return {
    directory,
    store,
    cleanup: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function directMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  const messageId = overrides.messageId ?? "message-1";
  return {
    messageId,
    dedupeKey: overrides.dedupeKey ?? messageId,
    platform: "qq",
    botInstanceId: "qq-main",
    conversation: {
      kind: "direct",
      platformConversationId: "user-1",
    },
    actor: {
      platformUserId: "user-1",
      displayName: "User",
    },
    parts: [{ type: "text", text: "hello" }],
    mentions: [],
    replyContext: {
      opaque: { messageId, contextToken: "short-lived-secret" },
    },
    receivedAt: new Date().toISOString(),
    triggered: true,
    ...overrides,
  };
}
