import { randomUUID } from "node:crypto";
import type { IMGentStore } from "../storage/store.js";
import type { ImAdapter, OutboundMessage, SendResult } from "@imgent/contracts";

function now(): string {
  return new Date().toISOString();
}

function withoutContext(message: OutboundMessage): OutboundMessage {
  const copy = structuredClone(message);
  delete copy.replyContext;
  return copy;
}

export class OutboundDispatcher {
  constructor(private readonly store: IMGentStore) {}

  async send(adapter: ImAdapter, message: OutboundMessage, taskId?: string): Promise<SendResult> {
    const row = this.store.get<{
      id: string;
      status: string;
      platform_message_id: string | null;
      send_mode: "reply" | "proactive" | null;
      attempt: number;
    }>(
      `SELECT id, status, platform_message_id, send_mode, attempt
       FROM outbound_messages WHERE idempotency_key = ?`,
      message.idempotencyKey,
    );
    if (row?.status === "sent" && row.send_mode) {
      return {
        ...(row.platform_message_id ? { platformMessageId: row.platform_message_id } : {}),
        mode: row.send_mode,
      };
    }

    const id = row?.id ?? `out_${randomUUID()}`;
    const timestamp = now();
    if (!row) {
      this.store.run(
        `INSERT INTO outbound_messages(
          id, task_id, bot_instance_id, idempotency_key, status, payload_json,
          reply_context_cipher, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        id,
        taskId ?? null,
        message.botInstanceId,
        message.idempotencyKey,
        JSON.stringify(withoutContext(message)),
        message.replyContext ? this.store.encryptReplyContext(message.replyContext) : null,
        timestamp,
        timestamp,
      );
    }
    this.store.run(
      `UPDATE outbound_messages
       SET status = 'sending', attempt = attempt + 1, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'failed', 'sending')`,
      timestamp,
      id,
    );

    try {
      const result = await adapter.send(message);
      this.store.transaction(() => {
        this.store.run(
          `UPDATE outbound_messages SET status = 'sent',
            platform_message_id = ?, send_mode = ?, error_code = NULL,
            updated_at = ? WHERE id = ?`,
          result.platformMessageId ?? null,
          result.mode,
          now(),
          id,
        );
      });
      return result;
    } catch (error) {
      const attempts = (row?.attempt ?? 0) + 1;
      const terminal = attempts >= 3;
      this.store.transaction(() => {
        this.store.run(
          `UPDATE outbound_messages SET status = ?, error_code = ?, updated_at = ?
           WHERE id = ?`,
          terminal ? "dead_letter" : "failed",
          classify(error),
          now(),
          id,
        );
        if (terminal) {
          this.store.addDeadLetter(
            "outbound.send",
            { errorCode: classify(error), message: errorMessage(error) },
            message.botInstanceId,
            id,
          );
        }
      });
      throw error;
    }
  }

  async drain(adapters: ReadonlyMap<string, ImAdapter>): Promise<number> {
    const rows = this.store.all<{
      id: string;
      task_id: string | null;
      bot_instance_id: string;
      payload_json: string;
      reply_context_cipher: Uint8Array | null;
    }>(
      `SELECT id, task_id, bot_instance_id, payload_json, reply_context_cipher
       FROM outbound_messages
       WHERE status IN ('pending', 'failed') AND attempt < 3
       ORDER BY created_at LIMIT 100`,
    );
    let sent = 0;
    for (const row of rows) {
      const adapter = adapters.get(row.bot_instance_id);
      if (!adapter) continue;
      const message = JSON.parse(row.payload_json) as OutboundMessage;
      const replyContext = this.store.decryptReplyContext(row.reply_context_cipher);
      if (replyContext) message.replyContext = replyContext;
      try {
        await this.send(adapter, message, row.task_id ?? undefined);
        sent += 1;
      } catch {
        // Bounded retries are recorded by send(); continue draining other bots.
      }
    }
    return sent;
  }
}

function classify(error: unknown): string {
  const message = errorMessage(error);
  if (/context_token|replyContext|过期/i.test(message)) return "REPLY_CONTEXT_INVALID";
  if (/HTTP 429|rate/i.test(message)) return "RATE_LIMITED";
  if (/HTTP 4\d\d/i.test(message)) return "PLATFORM_REJECTED";
  return "PLATFORM_SEND_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
