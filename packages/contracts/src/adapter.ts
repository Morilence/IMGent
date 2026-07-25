import type { ErrorDescriptor } from "./errors/descriptor.js";
import type {
  ConversationKind,
  InboundMessage,
  OutboundMessage,
  Platform,
  SendResult,
} from "./messaging.js";

export interface PlatformCapabilities {
  conversationKinds: readonly ConversationKind[];
  groupIngestion: "none" | "triggered" | "admin-opt-in-full";
  threads: boolean;
  inboundTransport: "websocket" | "long-polling" | "webhook";
  requiresReplyContext: boolean;
  supportsProactiveSend: boolean;
}

export interface AdapterReadiness {
  ready: boolean;
  issues: ErrorDescriptor[];
}

export interface ImAdapter {
  readonly id: Platform;
  readonly capabilities: PlatformCapabilities;
  start(
    onMessage: (
      message: InboundMessage,
      checkpoint?: { key: string; value: string },
    ) => Promise<void>,
  ): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<SendResult>;
  checkReady(depth?: "runtime" | "diagnostic"): Promise<AdapterReadiness>;
}
