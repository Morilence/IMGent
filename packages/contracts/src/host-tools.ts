export interface AgentHostToolSpec {
  namespace: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentHostToolCall {
  turnId: string;
  namespace: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentHostToolResult {
  success: boolean;
  text: string;
}

export type AgentHostToolHandler = (call: AgentHostToolCall) => Promise<AgentHostToolResult>;
