import type { AgentRequestAnswer, ApprovalRequest, UserQuestion } from "./approval.js";
import type { AgentProfile } from "./config.js";
import type { ErrorDescriptor } from "./errors/descriptor.js";
import type { ActorRole, MessagePart, Platform } from "./messaging.js";

export type AgentEvent =
  | { type: "output-delta"; text: string }
  | { type: "output-final"; text: string }
  | { type: "approval-request"; request: ApprovalRequest }
  | { type: "question"; request: UserQuestion }
  | { type: "session"; sessionId: string }
  | { type: "completed"; result: "success" | "cancelled" }
  | { type: "error"; error: ErrorDescriptor };

export type AgentTurnOrigin = "im" | "schedule" | "memory-curation";

export interface AgentTurnContext {
  origin: AgentTurnOrigin;
  conversation: {
    ref: string;
    kind: "direct" | "group";
    platform: Platform;
    botInstanceId: string;
    threadId?: string;
  };
  speaker: {
    ref: string;
    displayName?: string;
    role: ActorRole;
  };
}

export interface AgentTurnInput {
  turnId: string;
  conversationKey: string;
  sessionId?: string;
  profile: AgentProfile;
  context: AgentTurnContext;
  prompt: string;
  parts: MessagePart[];
  memoryContext: string[];
  developerInstructions?: string;
  ephemeral?: boolean;
  hostTools?: string[];
  builtInTools?: "default" | "none";
  signal?: AbortSignal;
}

export interface DriverReadiness {
  ready: boolean;
  version?: string;
  issues: ErrorDescriptor[];
}

export interface AgentDriver {
  readonly id: "codex" | "claude-code";
  readonly freshSessionMode?: "ephemeral" | "archive";
  checkReady(profile: AgentProfile, depth?: "runtime" | "diagnostic"): Promise<DriverReadiness>;
  runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent>;
  answerRequest(requestId: string, answer: AgentRequestAnswer): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  archiveSession?(sessionId: string): Promise<void>;
  close?(): Promise<void>;
}

export function formatAgentContextHeader(context: AgentTurnContext): string {
  const conversation = {
    kind: context.conversation.kind,
    ref: context.conversation.ref,
    platform: context.conversation.platform,
    botInstanceId: context.conversation.botInstanceId,
    ...(context.conversation.threadId ? { threadId: context.conversation.threadId } : {}),
  };
  const speaker = {
    ref: context.speaker.ref,
    ...(context.speaker.displayName ? { displayName: context.speaker.displayName } : {}),
    role: context.speaker.role,
  };
  return `[IMGent Context] ${JSON.stringify({ conversation, speaker })}`;
}
