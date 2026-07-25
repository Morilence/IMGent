import { createHash } from "node:crypto";
import type { StoredTask } from "../storage/store.js";
import type { AgentTurnContext, AgentTurnOrigin } from "@imgent/contracts";

export function stableAgentReference(
  prefix: "person" | "direct" | "group",
  agentProfileId: string,
  internalId: string,
): string {
  const digest = createHash("sha256")
    .update(agentProfileId)
    .update("\0")
    .update(internalId)
    .digest("hex")
    .slice(0, 10);
  return `${prefix}_${digest}`;
}

export function agentTurnContext(
  task: Pick<StoredTask, "agentProfileId" | "principalId" | "conversationSpaceId" | "message">,
  origin: AgentTurnOrigin,
): AgentTurnContext {
  const conversation = task.message.conversation;
  return {
    origin,
    conversation: {
      ref: stableAgentReference(conversation.kind, task.agentProfileId, task.conversationSpaceId),
      kind: conversation.kind,
      platform: task.message.platform,
      botInstanceId: task.message.botInstanceId,
      ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    },
    speaker: {
      ref: stableAgentReference("person", task.agentProfileId, task.principalId),
      ...(task.message.actor.displayName ? { displayName: task.message.actor.displayName } : {}),
      role: task.message.actor.role ?? "unknown",
    },
  };
}
