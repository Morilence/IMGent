import type { AgentRequestAnswer, ApprovalRequest, UserQuestion } from "./approval.js";
import type { AgentProfile } from "./config.js";
import type { ErrorDescriptor } from "./errors/descriptor.js";
import type { MessagePart } from "./messaging.js";

export type AgentEvent =
  | { type: "output-delta"; text: string }
  | { type: "output-final"; text: string }
  | { type: "approval-request"; request: ApprovalRequest }
  | { type: "question"; request: UserQuestion }
  | { type: "session"; sessionId: string }
  | { type: "completed"; result: "success" | "cancelled" }
  | { type: "error"; error: ErrorDescriptor };

export interface AgentTurnInput {
  turnId: string;
  conversationKey: string;
  sessionId?: string;
  profile: AgentProfile;
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
  checkReady(profile: AgentProfile, depth?: "runtime" | "diagnostic"): Promise<DriverReadiness>;
  runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent>;
  answerRequest(requestId: string, answer: AgentRequestAnswer): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  close?(): Promise<void>;
}
