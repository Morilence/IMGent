import type { SupportedLocale } from "./locale.js";
import type { Platform } from "./messaging.js";

export type PermissionMode = "deny" | "ask" | "allow";

export interface AgentProfile {
  id: string;
  driver: "codex" | "claude-code";
  command: string;
  workspace: string;
  prompt?: string;
  skills: string[];
  permissions: {
    maxMode: PermissionMode;
  };
  memory: {
    enabled: boolean;
  };
}

export interface BotInstance {
  id: string;
  adapter: Platform;
  transport?: "websocket";
  platformBotId?: string;
  platformBotIdEnv?: string;
  credentialRef: string;
  authorizingPlatformUserId?: string;
  baseUrl?: string;
  groupIngestionDefault?: "triggered";
  locale?: SupportedLocale;
  enabled?: boolean;
}

export interface Route {
  botInstanceId: string;
  agentProfileId: string;
}

export interface IMGentConfig {
  version: 1;
  defaultLocale: SupportedLocale;
  dataDir: string;
  server: {
    host: string;
    port: number;
  };
  allowedWorkspaceRoots?: string[];
  agentProfiles: AgentProfile[];
  bots: BotInstance[];
  routes: Route[];
}
