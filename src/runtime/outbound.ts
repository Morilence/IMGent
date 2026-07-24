import {
  IMGentError,
  normalizeError,
  type ErrorDescriptor,
  type ImAdapter,
  type OutboundMessage,
  type SendResult,
} from "@imgent/contracts";
import { Logger } from "./logger.js";
import type { IMGentStore } from "../storage/store.js";

function now(): string {
  return new Date().toISOString();
}

function nextAttempt(attempt: number, descriptor: ErrorDescriptor): string {
  const delay = descriptor.retry.retryAfterMs ?? (attempt <= 1 ? 1_000 : 5_000);
  return new Date(Date.now() + Math.min(delay, 300_000)).toISOString();
}

function outboundError(error: unknown): IMGentError {
  const normalized = normalizeError(error, "OUTBOUND_SEND_FAILED");
  switch (normalized.code) {
    case "OUTBOUND_RATE_LIMITED":
    case "ADAPTER_RATE_LIMITED": {
      const retryAfterMs = normalized.descriptor.retry.retryAfterMs;
      return new IMGentError("OUTBOUND_RATE_LIMITED", {
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        cause: normalized,
        ...(normalized.diagnostic ? { diagnostic: normalized.diagnostic } : {}),
      });
    }
    case "OUTBOUND_CONTEXT_EXPIRED":
    case "ADAPTER_REPLY_CONTEXT_INVALID":
      return new IMGentError("OUTBOUND_CONTEXT_EXPIRED", {
        cause: normalized,
        ...(normalized.diagnostic ? { diagnostic: normalized.diagnostic } : {}),
      });
    case "ADAPTER_REQUEST_REJECTED":
    case "ADAPTER_AUTH_REQUIRED":
    case "ADAPTER_PERMISSION_DENIED":
    case "ADAPTER_SESSION_INVALID":
    case "ADAPTER_COMPATIBILITY_ERROR":
    case "OUTBOUND_PLATFORM_REJECTED":
      return new IMGentError("OUTBOUND_PLATFORM_REJECTED", {
        cause: normalized,
        ...(normalized.diagnostic ? { diagnostic: normalized.diagnostic } : {}),
      });
    default:
      return new IMGentError("OUTBOUND_SEND_FAILED", {
        ...(normalized.descriptor.retry.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: normalized.descriptor.retry.retryAfterMs }),
        cause: normalized,
        ...(normalized.diagnostic ? { diagnostic: normalized.diagnostic } : {}),
      });
  }
}

interface StoredOutbound {
  id: string;
  task_id: string | null;
  bot_instance_id: string;
  status: "pending" | "sending" | "retry_wait" | "sent" | "dead_letter";
  payload_json: string;
  reply_context_cipher: Uint8Array | null;
  platform_message_id: string | null;
  send_mode: "reply" | "proactive" | null;
  attempt: number;
}

export class OutboundDispatcher {
  private readonly logger = new Logger("outbound");

  constructor(private readonly store: IMGentStore) {
    this.store.run(
      `UPDATE outbound_messages
       SET status = 'retry_wait', next_attempt_at = ?, updated_at = ?
       WHERE status = 'sending'`,
      now(),
      now(),
    );
  }

  enqueue(message: OutboundMessage, taskId?: string): string {
    return this.store.enqueueOutbound(message, taskId);
  }

  async send(adapter: ImAdapter, message: OutboundMessage, taskId?: string): Promise<SendResult> {
    const id = this.enqueue(message, taskId);
    const result = await this.dispatch(id, adapter);
    if (!result) {
      const row = this.row(id);
      if (row?.status === "sent" && row.send_mode) {
        return {
          ...(row.platform_message_id ? { platformMessageId: row.platform_message_id } : {}),
          mode: row.send_mode,
        };
      }
      throw new IMGentError("OUTBOUND_SEND_FAILED");
    }
    return result;
  }

  private row(id: string): StoredOutbound | undefined {
    return this.store.get<StoredOutbound>(
      `SELECT id, task_id, bot_instance_id, status, payload_json,
              reply_context_cipher, platform_message_id, send_mode, attempt
       FROM outbound_messages WHERE id = ?`,
      id,
    );
  }

  private async dispatch(id: string, adapter: ImAdapter): Promise<SendResult | undefined> {
    const row = this.row(id);
    if (!row) return undefined;
    if (row.status === "sent" && row.send_mode) {
      return {
        ...(row.platform_message_id ? { platformMessageId: row.platform_message_id } : {}),
        mode: row.send_mode,
      };
    }
    const claimed = this.store.database
      .prepare(
        `UPDATE outbound_messages
         SET status = 'sending', attempt = attempt + 1, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'retry_wait')`,
      )
      .run(now(), id).changes;
    if (claimed !== 1) return undefined;

    const message = JSON.parse(row.payload_json) as OutboundMessage;
    const replyContext = this.store.decryptReplyContext(row.reply_context_cipher);
    if (replyContext) message.replyContext = replyContext;
    const attempt = row.attempt + 1;
    try {
      const result = await adapter.send(message);
      this.store.run(
        `UPDATE outbound_messages
         SET status = 'sent', platform_message_id = ?, send_mode = ?,
             last_error_json = NULL, next_attempt_at = ?, updated_at = ?
         WHERE id = ?`,
        result.platformMessageId ?? null,
        result.mode,
        now(),
        now(),
        id,
      );
      return result;
    } catch (error) {
      const normalized = outboundError(error);
      const terminal = attempt >= 3 || normalized.descriptor.retry.strategy !== "backoff";
      this.store.transaction(() => {
        this.store.run(
          `UPDATE outbound_messages
           SET status = ?, last_error_json = ?, next_attempt_at = ?, updated_at = ?
           WHERE id = ?`,
          terminal ? "dead_letter" : "retry_wait",
          JSON.stringify(normalized.descriptor),
          terminal ? now() : nextAttempt(attempt, normalized.descriptor),
          now(),
          id,
        );
        if (terminal) {
          this.store.addDeadLetter(
            "outbound.send",
            normalized,
            { attempt },
            row.bot_instance_id,
            id,
          );
        }
      });
      const details = {
        outboundId: id,
        taskId: row.task_id ?? undefined,
        botInstanceId: row.bot_instance_id,
        attempt,
      };
      if (terminal) {
        this.logger.errorFrom("outbound.dead-lettered", normalized, details);
      } else {
        this.logger.warn("outbound.retry-scheduled", {
          ...details,
          errorCode: normalized.code,
          retryStrategy: normalized.descriptor.retry.strategy,
          incidentId: normalized.descriptor.incidentId,
        });
      }
      throw normalized;
    }
  }

  async drain(adapters: ReadonlyMap<string, ImAdapter>): Promise<number> {
    const rows = this.store.all<{ id: string; bot_instance_id: string }>(
      `SELECT id, bot_instance_id
       FROM outbound_messages
       WHERE status IN ('pending', 'retry_wait')
         AND next_attempt_at <= ?
         AND attempt < 3
       ORDER BY created_at LIMIT 100`,
      now(),
    );
    let sent = 0;
    for (const row of rows) {
      const adapter = adapters.get(row.bot_instance_id);
      if (!adapter) {
        const error = new IMGentError("OUTBOUND_PLATFORM_REJECTED", {
          diagnostic: { reason: "adapter missing", botInstanceId: row.bot_instance_id },
        });
        this.store.transaction(() => {
          this.store.run(
            `UPDATE outbound_messages
             SET status = 'dead_letter', last_error_json = ?, updated_at = ?
             WHERE id = ?`,
            JSON.stringify(error.descriptor),
            now(),
            row.id,
          );
          this.store.addDeadLetter(
            "outbound.adapter-missing",
            error,
            {},
            row.bot_instance_id,
            row.id,
          );
        });
        this.logger.errorFrom("outbound.adapter-missing", error, {
          outboundId: row.id,
          botInstanceId: row.bot_instance_id,
        });
        continue;
      }
      try {
        if (await this.dispatch(row.id, adapter)) sent += 1;
      } catch {
        // dispatch() records the retry or terminal dead letter.
      }
    }
    return sent;
  }
}
