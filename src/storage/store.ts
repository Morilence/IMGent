import { randomUUID } from "node:crypto";
import { IMGentError, normalizeError, redactSensitive } from "@imgent/contracts";
import { openDatabase } from "./database.js";
import type { SecretBox } from "../security/secret-box.js";
import type {
  ErrorDescriptor,
  InboundMessage,
  OutboundMessage,
  ReplyContext,
} from "@imgent/contracts";
import type { DatabaseSync } from "node:sqlite";

type SqlValue = null | number | bigint | string | Uint8Array;

export interface CheckpointUpdate {
  key: string;
  value: string;
}

export interface IngestResult {
  duplicate: boolean;
  eventId: string;
  taskId?: string;
  principalId: string;
  platformIdentityId: string;
  conversationSpaceId: string;
}

export interface StoredTask {
  id: string;
  inboundEventId?: string;
  scheduleRunId?: string;
  agentProfileId: string;
  principalId: string;
  conversationSpaceId: string;
  conversationKey: string;
  executionKey: string;
  sessionKey?: string;
  idempotencyKey: string;
  curateMemory: boolean;
  status: TaskStatus;
  attempt: number;
  dangerousSideEffectStarted: boolean;
  message: InboundMessage;
  finalText?: string;
  error?: ErrorDescriptor;
  nextAttemptAt?: string;
  createdAt: string;
}

export interface StoredConversationTurn {
  taskId: string;
  agentProfileId: string;
  principalId: string;
  conversationSpaceId: string;
  message: InboundMessage;
  finalText?: string;
  createdAt: string;
}

export type TaskStatus =
  | "queued"
  | "active"
  | "retry_wait"
  | "waiting_approval"
  | "succeeded"
  | "cancelled"
  | "failed"
  | "dead_letter";

function now(): string {
  return new Date().toISOString();
}

function rowId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function stripReplyContext(message: InboundMessage): InboundMessage {
  const copy = structuredClone(message);
  delete copy.replyContext;
  return copy;
}

function withoutReplyContext(message: OutboundMessage): OutboundMessage {
  const copy = structuredClone(message);
  delete copy.replyContext;
  return copy;
}

export class IMGentStore {
  private constructor(
    readonly database: DatabaseSync,
    private readonly secretBox: SecretBox,
    readonly path: string,
  ) {}

  static async open(path: string, secretBox: SecretBox): Promise<IMGentStore> {
    return new IMGentStore(await openDatabase(path), secretBox, path);
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.database.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.database.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SqlValue[]): void {
    this.database.prepare(sql).run(...params);
  }

  decryptReplyContext(value: Uint8Array | null): ReplyContext | undefined {
    if (!value) return undefined;
    return JSON.parse(this.secretBox.decrypt(value)) as ReplyContext;
  }

  encryptReplyContext(value: ReplyContext): Buffer {
    return this.secretBox.encrypt(JSON.stringify(value));
  }

  ingest(
    message: InboundMessage,
    agentProfileId: string,
    conversationKey: string,
    checkpoint?: CheckpointUpdate,
    enqueue = true,
  ): IngestResult {
    return this.transaction(() => {
      const duplicate = this.get<{
        id: string;
        principal_id: string;
        conversation_space_id: string;
      }>(
        `SELECT id, principal_id, conversation_space_id
         FROM inbound_events WHERE bot_instance_id = ? AND dedupe_key = ?`,
        message.botInstanceId,
        message.dedupeKey,
      );
      if (duplicate) {
        if (checkpoint) this.setCheckpoint(message.botInstanceId, checkpoint);
        const identity = this.get<{ id: string }>(
          `SELECT id FROM platform_identities
           WHERE agent_profile_id = ? AND platform = ? AND bot_instance_id = ?
             AND platform_user_id = ?`,
          agentProfileId,
          message.platform,
          message.botInstanceId,
          message.actor.platformUserId,
        );
        return {
          duplicate: true,
          eventId: duplicate.id,
          principalId: duplicate.principal_id,
          platformIdentityId: identity?.id ?? "",
          conversationSpaceId: duplicate.conversation_space_id,
        };
      }

      const identity = this.ensureIdentity(message, agentProfileId);
      const spaceId = this.ensureConversationSpace(message, agentProfileId);
      if (message.conversation.kind === "group") {
        this.upsertGroupMembership(message, spaceId, identity.principalId);
      }

      const eventId = rowId("evt");
      const replyContextCipher = message.replyContext
        ? this.secretBox.encrypt(JSON.stringify(message.replyContext))
        : null;
      const groupMode =
        message.conversation.kind === "group"
          ? (this.get<{ mode: "triggered" | "full" }>(
              "SELECT mode FROM group_policies WHERE conversation_space_id = ?",
              spaceId,
            )?.mode ?? "triggered")
          : undefined;
      const ordinaryFullMessage =
        message.conversation.kind === "group" &&
        message.triggered === false &&
        groupMode === "full";
      const rawExpiresAt = ordinaryFullMessage
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString()
        : null;

      this.run(
        `INSERT INTO inbound_events(
          id, platform, bot_instance_id, event_id, message_id, dedupe_key, sequence,
          conversation_space_id, principal_id, message_json, reply_context_cipher,
          received_at, raw_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        message.platform,
        message.botInstanceId,
        message.eventId ?? null,
        message.messageId,
        message.dedupeKey,
        message.sequence ?? null,
        spaceId,
        identity.principalId,
        JSON.stringify(stripReplyContext(message)),
        replyContextCipher,
        message.receivedAt,
        rawExpiresAt,
      );

      let taskId: string | undefined;
      if (ordinaryFullMessage) {
        const contextTaskId = rowId("context");
        const timestamp = now();
        this.run(
          `INSERT INTO tasks(
            id, inbound_event_id, agent_profile_id, principal_id,
            conversation_space_id, conversation_key, execution_key, session_key,
            idempotency_key, message_json, reply_context_cipher, curate_memory, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'succeeded', ?, ?)`,
          contextTaskId,
          eventId,
          agentProfileId,
          identity.principalId,
          spaceId,
          conversationKey,
          conversationKey,
          conversationKey,
          `context:${message.botInstanceId}:${message.dedupeKey}`,
          JSON.stringify(stripReplyContext(message)),
          replyContextCipher,
          timestamp,
          timestamp,
        );
        this.enqueueMemoryOutbox(contextTaskId);
      } else if (enqueue && message.triggered !== false) {
        taskId = rowId("task");
        const timestamp = now();
        this.run(
          `INSERT INTO tasks(
            id, inbound_event_id, agent_profile_id, principal_id,
            conversation_space_id, conversation_key, execution_key, session_key,
            idempotency_key, message_json, reply_context_cipher, curate_memory, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, ?)`,
          taskId,
          eventId,
          agentProfileId,
          identity.principalId,
          spaceId,
          conversationKey,
          conversationKey,
          conversationKey,
          `turn:${message.botInstanceId}:${message.dedupeKey}`,
          JSON.stringify(stripReplyContext(message)),
          replyContextCipher,
          timestamp,
          timestamp,
        );
      }
      if (checkpoint) this.setCheckpoint(message.botInstanceId, checkpoint);
      return {
        duplicate: false,
        eventId,
        ...(taskId ? { taskId } : {}),
        principalId: identity.principalId,
        platformIdentityId: identity.id,
        conversationSpaceId: spaceId,
      };
    });
  }

  enqueueInboundEvent(
    eventId: string,
    agentProfileId: string,
    conversationKey: string,
  ): string | undefined {
    return this.transaction(() => {
      const existing = this.get<{ id: string }>(
        "SELECT id FROM tasks WHERE inbound_event_id = ?",
        eventId,
      );
      if (existing) return existing.id;
      const event = this.get<{
        principal_id: string;
        conversation_space_id: string;
        bot_instance_id: string;
        dedupe_key: string;
        message_json: string;
        reply_context_cipher: Uint8Array | null;
      }>(
        `SELECT principal_id, conversation_space_id, bot_instance_id,
                dedupe_key, message_json, reply_context_cipher
         FROM inbound_events WHERE id = ?`,
        eventId,
      );
      if (!event) throw new Error("入站事件不存在");
      const message = JSON.parse(event.message_json) as InboundMessage | { expired: true };
      if ("expired" in message || message.triggered === false) return undefined;
      const taskId = rowId("task");
      const timestamp = now();
      this.run(
        `INSERT INTO tasks(
          id, inbound_event_id, agent_profile_id, principal_id,
          conversation_space_id, conversation_key, execution_key, session_key,
          idempotency_key, message_json, reply_context_cipher, curate_memory, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, ?)`,
        taskId,
        eventId,
        agentProfileId,
        event.principal_id,
        event.conversation_space_id,
        conversationKey,
        conversationKey,
        conversationKey,
        `turn:${event.bot_instance_id}:${event.dedupe_key}`,
        event.message_json,
        event.reply_context_cipher,
        timestamp,
        timestamp,
      );
      return taskId;
    });
  }

  private ensureIdentity(
    message: InboundMessage,
    agentProfileId: string,
  ): { id: string; principalId: string } {
    const existing = this.get<{ id: string; principal_id: string }>(
      `SELECT id, principal_id FROM platform_identities
       WHERE agent_profile_id = ? AND platform = ? AND bot_instance_id = ?
         AND platform_user_id = ?`,
      agentProfileId,
      message.platform,
      message.botInstanceId,
      message.actor.platformUserId,
    );
    if (existing) {
      this.run(
        "UPDATE platform_identities SET display_name = ?, updated_at = ? WHERE id = ?",
        message.actor.displayName ?? null,
        now(),
        existing.id,
      );
      return { id: existing.id, principalId: existing.principal_id };
    }
    const principalId = rowId("principal");
    const identityId = rowId("identity");
    const timestamp = now();
    this.run(
      "INSERT INTO principals(id, agent_profile_id, created_at) VALUES (?, ?, ?)",
      principalId,
      agentProfileId,
      timestamp,
    );
    this.run(
      `INSERT INTO platform_identities(
        id, agent_profile_id, platform, bot_instance_id, platform_user_id,
        principal_id, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      identityId,
      agentProfileId,
      message.platform,
      message.botInstanceId,
      message.actor.platformUserId,
      principalId,
      message.actor.displayName ?? null,
      timestamp,
      timestamp,
    );
    return { id: identityId, principalId };
  }

  private ensureConversationSpace(message: InboundMessage, agentProfileId: string): string {
    const existing = this.get<{ id: string }>(
      `SELECT id FROM conversation_spaces
       WHERE agent_profile_id = ? AND platform = ? AND bot_instance_id = ?
         AND kind = ? AND platform_conversation_id = ?`,
      agentProfileId,
      message.platform,
      message.botInstanceId,
      message.conversation.kind,
      message.conversation.platformConversationId,
    );
    if (existing) return existing.id;
    if (message.platform === "wechat-ilink" && message.conversation.kind !== "direct") {
      throw new Error("微信 iLink v1 禁止创建群 ConversationSpace");
    }
    const id = rowId("space");
    this.run(
      `INSERT INTO conversation_spaces(
        id, agent_profile_id, platform, bot_instance_id, kind,
        platform_conversation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      agentProfileId,
      message.platform,
      message.botInstanceId,
      message.conversation.kind,
      message.conversation.platformConversationId,
      now(),
    );
    if (message.conversation.kind === "group") {
      this.run(
        `INSERT INTO group_policies(
          conversation_space_id, mode, platform_full_capability, changed_at
        ) VALUES (?, 'triggered', 0, ?)`,
        id,
        now(),
      );
    }
    return id;
  }

  private upsertGroupMembership(
    message: InboundMessage,
    spaceId: string,
    principalId: string,
  ): void {
    this.run(
      `INSERT INTO group_memberships(
        conversation_space_id, principal_id, platform_member_id,
        display_name, role, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_space_id, principal_id) DO UPDATE SET
        platform_member_id = excluded.platform_member_id,
        display_name = excluded.display_name,
        role = excluded.role,
        confirmed_at = excluded.confirmed_at`,
      spaceId,
      principalId,
      message.actor.platformMemberId ?? null,
      message.actor.displayName ?? null,
      message.actor.role ?? "unknown",
      now(),
    );
  }

  setCheckpoint(botInstanceId: string, checkpoint: CheckpointUpdate): void {
    this.run(
      `INSERT INTO transport_checkpoints(bot_instance_id, checkpoint_key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bot_instance_id, checkpoint_key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`,
      botInstanceId,
      checkpoint.key,
      checkpoint.value,
      now(),
    );
  }

  checkpoint(botInstanceId: string, key: string): string | undefined {
    return this.get<{ value: string }>(
      "SELECT value FROM transport_checkpoints WHERE bot_instance_id = ? AND checkpoint_key = ?",
      botInstanceId,
      key,
    )?.value;
  }

  claimNextTask(): StoredTask | undefined {
    return this.transaction(() => {
      const row = this.get<{
        id: string;
        inbound_event_id: string | null;
        schedule_run_id: string | null;
        agent_profile_id: string;
        principal_id: string;
        conversation_space_id: string;
        conversation_key: string;
        execution_key: string;
        session_key: string | null;
        idempotency_key: string;
        curate_memory: number;
        status: TaskStatus;
        attempt: number;
        dangerous_side_effect_started: number;
        message_json: string;
        reply_context_cipher: Uint8Array | null;
        created_at: string;
      }>(
        `SELECT t.*
         FROM tasks t INDEXED BY tasks_claim_idx
         WHERE t.status IN ('queued', 'retry_wait')
           AND (t.status = 'queued' OR t.next_attempt_at <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM tasks active
             WHERE active.execution_key = t.execution_key
               AND active.status IN ('active', 'waiting_approval')
           )
           AND NOT EXISTS (
             SELECT 1 FROM tasks earlier
             WHERE earlier.execution_key = t.execution_key
               AND earlier.status IN ('queued', 'retry_wait', 'active', 'waiting_approval')
               AND (
                 earlier.created_at < t.created_at
                 OR (earlier.created_at = t.created_at AND earlier.rowid < t.rowid)
               )
           )
         ORDER BY t.created_at
         LIMIT 1`,
        now(),
      );
      if (!row) return undefined;
      this.run(
        `UPDATE tasks SET status = 'active', attempt = attempt + 1,
           next_attempt_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'retry_wait')`,
        now(),
        row.id,
      );
      const message = JSON.parse(row.message_json) as InboundMessage;
      const replyContext = this.decryptReplyContext(row.reply_context_cipher);
      if (replyContext) message.replyContext = replyContext;
      return {
        id: row.id,
        ...(row.inbound_event_id ? { inboundEventId: row.inbound_event_id } : {}),
        ...(row.schedule_run_id ? { scheduleRunId: row.schedule_run_id } : {}),
        agentProfileId: row.agent_profile_id,
        principalId: row.principal_id,
        conversationSpaceId: row.conversation_space_id,
        conversationKey: row.conversation_key,
        executionKey: row.execution_key,
        ...(row.session_key ? { sessionKey: row.session_key } : {}),
        idempotencyKey: row.idempotency_key,
        curateMemory: row.curate_memory === 1,
        status: "active",
        attempt: row.attempt + 1,
        dangerousSideEffectStarted: row.dangerous_side_effect_started === 1,
        message,
        createdAt: row.created_at,
      };
    });
  }

  transitionTask(
    taskId: string,
    from: readonly TaskStatus[],
    to: TaskStatus,
    fields: {
      finalText?: string;
      error?: ErrorDescriptor;
      nextAttemptAt?: string | null;
    } = {},
  ): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const result = this.database
      .prepare(
        `UPDATE tasks SET status = ?, final_text = COALESCE(?, final_text),
          error_json = ?, incident_id = ?, next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(
        to,
        fields.finalText ?? null,
        fields.error ? JSON.stringify(fields.error) : null,
        fields.error?.incidentId ?? null,
        fields.nextAttemptAt ?? null,
        now(),
        taskId,
        ...from,
      );
    return result.changes === 1;
  }

  completeTask(taskId: string, finalText: string, curate: boolean): boolean {
    return this.transaction(() => {
      const changed = this.transitionTask(taskId, ["active"], "succeeded", { finalText });
      if (changed && curate) this.enqueueMemoryOutbox(taskId);
      return changed;
    });
  }

  enqueueOutbound(message: OutboundMessage, taskId?: string): string {
    const timestamp = now();
    const existing = this.get<{ id: string }>(
      "SELECT id FROM outbound_messages WHERE idempotency_key = ?",
      message.idempotencyKey,
    );
    if (existing) return existing.id;
    const id = rowId("out");
    this.run(
      `INSERT INTO outbound_messages(
        id, task_id, bot_instance_id, idempotency_key, status, payload_json,
        reply_context_cipher, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      id,
      taskId ?? null,
      message.botInstanceId,
      message.idempotencyKey,
      JSON.stringify(withoutReplyContext(message)),
      message.replyContext ? this.encryptReplyContext(message.replyContext) : null,
      timestamp,
      timestamp,
      timestamp,
    );
    return id;
  }

  completeTaskWithOutbound(
    taskId: string,
    finalText: string,
    curate: boolean,
    message: OutboundMessage,
  ): boolean {
    return this.transaction(() => {
      const changed = this.transitionTask(taskId, ["active"], "succeeded", { finalText });
      if (!changed) return false;
      this.enqueueOutbound(message, taskId);
      if (curate) this.enqueueMemoryOutbox(taskId);
      return true;
    });
  }

  cancelConversation(
    conversationKey: string,
    principalId: string,
  ): { activeTurnIds: string[]; cancelledQueued: number } {
    return this.transaction(() => {
      const activeTurnIds = this.all<{ id: string }>(
        `SELECT id FROM tasks
         WHERE conversation_key = ? AND principal_id = ?
           AND status IN ('active', 'waiting_approval')`,
        conversationKey,
        principalId,
      ).map((row) => row.id);
      const cancelledQueued = this.database
        .prepare(
          `UPDATE tasks SET status = 'cancelled', updated_at = ?
           WHERE conversation_key = ? AND principal_id = ?
             AND status IN ('queued', 'retry_wait')`,
        )
        .run(now(), conversationKey, principalId).changes;
      return {
        activeTurnIds,
        cancelledQueued: Number(cancelledQueued),
      };
    });
  }

  task(taskId: string): StoredTask | undefined {
    const row = this.get<{
      id: string;
      inbound_event_id: string | null;
      schedule_run_id: string | null;
      agent_profile_id: string;
      principal_id: string;
      conversation_space_id: string;
      conversation_key: string;
      execution_key: string;
      session_key: string | null;
      idempotency_key: string;
      curate_memory: number;
      status: TaskStatus;
      attempt: number;
      dangerous_side_effect_started: number;
      message_json: string;
      reply_context_cipher: Uint8Array | null;
      final_text: string | null;
      error_json: string | null;
      next_attempt_at: string | null;
      created_at: string;
    }>(`SELECT t.* FROM tasks t WHERE t.id = ?`, taskId);
    if (!row) return undefined;
    const message = JSON.parse(row.message_json) as InboundMessage;
    const replyContext = this.decryptReplyContext(row.reply_context_cipher);
    if (replyContext) message.replyContext = replyContext;
    return {
      id: row.id,
      ...(row.inbound_event_id ? { inboundEventId: row.inbound_event_id } : {}),
      ...(row.schedule_run_id ? { scheduleRunId: row.schedule_run_id } : {}),
      agentProfileId: row.agent_profile_id,
      principalId: row.principal_id,
      conversationSpaceId: row.conversation_space_id,
      conversationKey: row.conversation_key,
      executionKey: row.execution_key,
      ...(row.session_key ? { sessionKey: row.session_key } : {}),
      idempotencyKey: row.idempotency_key,
      curateMemory: row.curate_memory === 1,
      status: row.status,
      attempt: row.attempt,
      dangerousSideEffectStarted: row.dangerous_side_effect_started === 1,
      message,
      ...(row.final_text ? { finalText: row.final_text } : {}),
      ...(row.error_json ? { error: JSON.parse(row.error_json) as ErrorDescriptor } : {}),
      ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
      createdAt: row.created_at,
    };
  }

  recentInboundTurns(
    taskId: string,
    withinMs = 24 * 60 * 60 * 1_000,
    limit = 6,
  ): StoredConversationTurn[] {
    const current = this.get<{
      row_id: number;
      agent_profile_id: string;
      conversation_space_id: string;
      conversation_key: string;
      created_at: string;
    }>(
      `SELECT rowid AS row_id, agent_profile_id, conversation_space_id,
              conversation_key, created_at
       FROM tasks WHERE id = ?`,
      taskId,
    );
    if (!current) return [];
    const since = new Date(Date.parse(current.created_at) - Math.max(0, withinMs)).toISOString();
    const boundedLimit = Math.max(0, Math.min(limit, 20));
    if (boundedLimit === 0) return [];
    const rows = this.all<{
      row_id: number;
      id: string;
      agent_profile_id: string;
      principal_id: string;
      conversation_space_id: string;
      message_json: string;
      final_text: string | null;
      created_at: string;
    }>(
      `SELECT rowid AS row_id, id, agent_profile_id, principal_id,
              conversation_space_id, message_json, final_text, created_at
       FROM tasks
       WHERE inbound_event_id IS NOT NULL
         AND agent_profile_id = ?
         AND conversation_space_id = ?
         AND conversation_key = ?
         AND created_at >= ?
         AND (
           created_at < ?
           OR (created_at = ? AND rowid < ?)
         )
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
      current.agent_profile_id,
      current.conversation_space_id,
      current.conversation_key,
      since,
      current.created_at,
      current.created_at,
      current.row_id,
      boundedLimit,
    );
    return rows.reverse().map((row) => ({
      taskId: row.id,
      agentProfileId: row.agent_profile_id,
      principalId: row.principal_id,
      conversationSpaceId: row.conversation_space_id,
      message: JSON.parse(row.message_json) as InboundMessage,
      ...(row.final_text ? { finalText: row.final_text } : {}),
      createdAt: row.created_at,
    }));
  }

  addDeadLetter(
    category: string,
    error: unknown,
    diagnostic: Record<string, unknown>,
    botInstanceId?: string,
    referenceId?: string,
  ): void {
    const normalized = normalizeError(error);
    this.run(
      `INSERT INTO dead_letters(
        id, category, bot_instance_id, reference_id, error_json,
        diagnostic_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rowId("dead"),
      category,
      botInstanceId ?? null,
      referenceId ?? null,
      JSON.stringify(normalized.descriptor),
      JSON.stringify(
        redactSensitive(
          normalized.diagnostic ? { ...diagnostic, ...normalized.diagnostic } : diagnostic,
        ),
      ),
      now(),
    );
  }

  markDangerousSideEffect(taskId: string): void {
    this.run(
      "UPDATE tasks SET dangerous_side_effect_started = 1, updated_at = ? WHERE id = ?",
      now(),
      taskId,
    );
  }

  recoverAfterRestart(): { requeued: number; deadLettered: number } {
    return this.transaction(() => {
      const timestamp = now();
      this.run(
        `UPDATE approvals SET status = 'expired', decided_at = ?
         WHERE status = 'pending'
           AND task_id IN (
             SELECT id FROM tasks WHERE status = 'waiting_approval'
           )`,
        timestamp,
      );
      const recoveryError = new IMGentError("PROCESS_RESTART_RECOVERY").descriptor;
      this.run(
        `UPDATE memory_outbox
         SET status = CASE WHEN attempt >= 3 THEN 'dead_letter' ELSE 'retry_wait' END,
             next_attempt_at = ?, last_error_json = ?, updated_at = ?
         WHERE status = 'processing'`,
        timestamp,
        JSON.stringify(recoveryError),
        timestamp,
      );
      const requeued = this.database
        .prepare(
          `UPDATE tasks SET status = 'retry_wait', error_json = ?,
            incident_id = ?, next_attempt_at = ?, updated_at = ?
           WHERE status = 'active'
             AND dangerous_side_effect_started = 0`,
        )
        .run(
          JSON.stringify(recoveryError),
          recoveryError.incidentId ?? null,
          timestamp,
          timestamp,
        ).changes;
      const unsafeError = new IMGentError("TASK_UNSAFE_REPLAY").descriptor;
      const deadLettered = this.database
        .prepare(
          `UPDATE tasks SET status = 'dead_letter', error_json = ?,
            incident_id = ?, next_attempt_at = NULL, updated_at = ?
           WHERE status = 'waiting_approval'
              OR (status = 'active' AND dangerous_side_effect_started = 1)`,
        )
        .run(JSON.stringify(unsafeError), unsafeError.incidentId ?? null, timestamp).changes;
      return {
        requeued: Number(requeued),
        deadLettered: Number(deadLettered),
      };
    });
  }

  saveSession(
    conversationKey: string,
    driver: "codex" | "claude-code",
    sessionId: string,
    workspace: string,
  ): void {
    this.run(
      `INSERT INTO agent_sessions(
        conversation_key, driver, session_id, workspace, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        driver = excluded.driver, session_id = excluded.session_id,
        workspace = excluded.workspace, updated_at = excluded.updated_at`,
      conversationKey,
      driver,
      sessionId,
      workspace,
      now(),
    );
  }

  session(
    conversationKey: string,
  ): { driver: "codex" | "claude-code"; sessionId: string; workspace: string } | undefined {
    const row = this.get<{
      driver: "codex" | "claude-code";
      session_id: string;
      workspace: string;
    }>(
      "SELECT driver, session_id, workspace FROM agent_sessions WHERE conversation_key = ?",
      conversationKey,
    );
    return row
      ? { driver: row.driver, sessionId: row.session_id, workspace: row.workspace }
      : undefined;
  }

  enqueueMemoryOutbox(taskId: string): void {
    const timestamp = now();
    this.run(
      `INSERT INTO memory_outbox(
        id, task_id, status, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(task_id) DO NOTHING`,
      rowId("curate"),
      taskId,
      timestamp,
      timestamp,
      timestamp,
    );
  }
}
