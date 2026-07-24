export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  sanitizedInput: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  expiresAt: string;
}

export interface UserQuestion {
  requestId: string;
  prompt: string;
  choices?: string[];
  expiresAt: string;
}

export type AgentRequestAnswer =
  { decision: "allow" | "deny"; remember?: boolean } | { decision: "answer"; value: string };
