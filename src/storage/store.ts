import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { memorySearchText } from "../memory/search-text.js";
import { MIGRATION_1, MIGRATION_2, SCHEMA_VERSION } from "./migrations.js";
import type { SecretBox } from "../security/secret-box.js";
import type { InboundMessage, ReplyContext } from "@imgent/contracts";

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
  inboundEventId: string;
  agentProfileId: string;
  principalId: string;
  conversationSpaceId: string;
  conversationKey: string;
  idempotencyKey: string;
  status: TaskStatus;
  attempt: number;
  message: InboundMessage;
  finalText?: string;
  createdAt: string;
}

export type TaskStatus =
  "queued" | "active" | "waiting_approval" | "succeeded" | "cancelled" | "failed" | "dead_letter";

interface CountRow {
  count: number;
}

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

export class IMGentStore {
  private constructor(
    readonly database: DatabaseSync,
    private readonly secretBox: SecretBox,
    readonly path: string,
  ) {}

  static async open(path: string, secretBox: SecretBox): Promise<IMGentStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      defensive: true,
      timeout: 5_000,
    });
    await chmod(path, 0o600);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");

    const tables = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
      )
      .get() as unknown as CountRow;
    let rebuildMemoryIndex = false;
    if (tables.count === 0) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(MIGRATION_1);
        database.exec("COMMIT");
        rebuildMemoryIndex = true;
      } catch (error) {
        database.exec("ROLLBACK");
        database.close();
        throw error;
      }
    } else {
      const version = database.prepare("SELECT version FROM schema_meta").get() as
        { version: number } | undefined;
      if (version?.version === 1) {
        const backupPath = `${path}.pre-migrate-${Date.now()}.backup`;
        await backup(database, backupPath);
        await chmod(backupPath, 0o600);
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(MIGRATION_2);
          database.exec("COMMIT");
          rebuildMemoryIndex = true;
        } catch (error) {
          database.exec("ROLLBACK");
          database.close();
          throw new Error(
            `数据库 schema v2 迁移失败；已备份到 ${backupPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }
      } else if (!version || version.version !== SCHEMA_VERSION) {
        const backupPath = `${path}.pre-migrate-${Date.now()}.backup`;
        await backup(database, backupPath);
        await chmod(backupPath, 0o600);
        database.close();
        throw new Error(
          `数据库 schema version ${version?.version ?? "unknown"} 不受支持；已备份到 ${backupPath}`,
        );
      }
    }

    const fts = database
      .prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
      .get() as unknown as { enabled: number };
    if (fts.enabled !== 1) {
      database.close();
      throw new Error("当前 SQLite 未启用 FTS5");
    }
    database.prepare("INSERT INTO memory_fts(search_text) VALUES (?)").run("tokenizer-check");
    database.prepare("DELETE FROM memory_fts WHERE search_text = ?").run("tokenizer-check");
    if (rebuildMemoryIndex) {
      const records = database
        .prepare("SELECT id, value FROM memory_records WHERE status = 'active'")
        .all() as unknown as Array<{ id: string; value: string }>;
      const insert = database.prepare(
        "INSERT INTO memory_fts(memory_id, search_text) VALUES (?, ?)",
      );
      for (const record of records) insert.run(record.id, memorySearchText(record.value));
    }

    return new IMGentStore(database, secretBox, path);
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
            conversation_space_id, conversation_key, idempotency_key, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?)`,
          contextTaskId,
          eventId,
          agentProfileId,
          identity.principalId,
          spaceId,
          conversationKey,
          `context:${message.botInstanceId}:${message.dedupeKey}`,
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
            conversation_space_id, conversation_key, idempotency_key, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          taskId,
          eventId,
          agentProfileId,
          identity.principalId,
          spaceId,
          conversationKey,
          `turn:${message.botInstanceId}:${message.dedupeKey}`,
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
      }>(
        `SELECT principal_id, conversation_space_id, bot_instance_id,
                dedupe_key, message_json
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
          conversation_space_id, conversation_key, idempotency_key, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        taskId,
        eventId,
        agentProfileId,
        event.principal_id,
        event.conversation_space_id,
        conversationKey,
        `turn:${event.bot_instance_id}:${event.dedupe_key}`,
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
        inbound_event_id: string;
        agent_profile_id: string;
        principal_id: string;
        conversation_space_id: string;
        conversation_key: string;
        idempotency_key: string;
        status: TaskStatus;
        attempt: number;
        message_json: string;
        reply_context_cipher: Uint8Array | null;
        created_at: string;
      }>(
        `SELECT t.*, e.message_json, e.reply_context_cipher
         FROM tasks t JOIN inbound_events e ON e.id = t.inbound_event_id
         WHERE t.status = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM tasks active
             WHERE active.conversation_key = t.conversation_key
               AND active.status IN ('active', 'waiting_approval')
           )
         ORDER BY t.created_at, t.rowid
         LIMIT 1`,
      );
      if (!row) return undefined;
      this.run(
        `UPDATE tasks SET status = 'active', attempt = attempt + 1, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
        now(),
        row.id,
      );
      const message = JSON.parse(row.message_json) as InboundMessage;
      const replyContext = this.decryptReplyContext(row.reply_context_cipher);
      if (replyContext) message.replyContext = replyContext;
      return {
        id: row.id,
        inboundEventId: row.inbound_event_id,
        agentProfileId: row.agent_profile_id,
        principalId: row.principal_id,
        conversationSpaceId: row.conversation_space_id,
        conversationKey: row.conversation_key,
        idempotencyKey: row.idempotency_key,
        status: "active",
        attempt: row.attempt + 1,
        message,
        createdAt: row.created_at,
      };
    });
  }

  transitionTask(
    taskId: string,
    from: readonly TaskStatus[],
    to: TaskStatus,
    fields: { finalText?: string; errorCode?: string; errorMessage?: string } = {},
  ): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const result = this.database
      .prepare(
        `UPDATE tasks SET status = ?, final_text = COALESCE(?, final_text),
          error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(
        to,
        fields.finalText ?? null,
        fields.errorCode ?? null,
        fields.errorMessage ?? null,
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
           WHERE conversation_key = ? AND principal_id = ? AND status = 'queued'`,
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
      inbound_event_id: string;
      agent_profile_id: string;
      principal_id: string;
      conversation_space_id: string;
      conversation_key: string;
      idempotency_key: string;
      status: TaskStatus;
      attempt: number;
      message_json: string;
      reply_context_cipher: Uint8Array | null;
      final_text: string | null;
      created_at: string;
    }>(
      `SELECT t.*, e.message_json, e.reply_context_cipher
       FROM tasks t JOIN inbound_events e ON e.id = t.inbound_event_id
       WHERE t.id = ?`,
      taskId,
    );
    if (!row) return undefined;
    const message = JSON.parse(row.message_json) as InboundMessage;
    const replyContext = this.decryptReplyContext(row.reply_context_cipher);
    if (replyContext) message.replyContext = replyContext;
    return {
      id: row.id,
      inboundEventId: row.inbound_event_id,
      agentProfileId: row.agent_profile_id,
      principalId: row.principal_id,
      conversationSpaceId: row.conversation_space_id,
      conversationKey: row.conversation_key,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      attempt: row.attempt,
      message,
      ...(row.final_text ? { finalText: row.final_text } : {}),
      createdAt: row.created_at,
    };
  }

  addDeadLetter(
    category: string,
    diagnostic: Record<string, unknown>,
    botInstanceId?: string,
    referenceId?: string,
  ): void {
    this.run(
      `INSERT INTO dead_letters(
        id, category, bot_instance_id, reference_id, diagnostic_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      rowId("dead"),
      category,
      botInstanceId ?? null,
      referenceId ?? null,
      JSON.stringify(diagnostic),
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
      this.run(
        `UPDATE approvals SET status = 'expired', decided_at = ?
         WHERE status = 'pending'
           AND task_id IN (
             SELECT id FROM tasks WHERE status = 'waiting_approval'
           )`,
        now(),
      );
      const requeued = this.database
        .prepare(
          `UPDATE tasks SET status = 'queued', error_code = 'PROCESS_RESTART',
            error_message = '进程重启后等待恢复', updated_at = ?
           WHERE status IN ('active', 'waiting_approval')
             AND dangerous_side_effect_started = 0`,
        )
        .run(now()).changes;
      const deadLettered = this.database
        .prepare(
          `UPDATE tasks SET status = 'dead_letter', error_code = 'UNSAFE_REPLAY',
            error_message = '危险操作可能已开始，禁止自动重放', updated_at = ?
           WHERE status IN ('active', 'waiting_approval')
             AND dangerous_side_effect_started = 1`,
        )
        .run(now()).changes;
      return {
        requeued: Number(requeued),
        deadLettered: Number(deadLettered),
      };
    });
  }

  saveSession(
    conversationKey: string,
    agentProfileId: string,
    driver: "codex" | "claude-code",
    sessionId: string,
    workspace: string,
  ): void {
    this.run(
      `INSERT INTO agent_sessions(
        conversation_key, agent_profile_id, driver, session_id, workspace, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        driver = excluded.driver, session_id = excluded.session_id,
        workspace = excluded.workspace, updated_at = excluded.updated_at`,
      conversationKey,
      agentProfileId,
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

  cleanupExpiredRawEvents(): number {
    return Number(
      this.database
        .prepare(
          `UPDATE inbound_events
         SET message_json = '{"expired":true}', reply_context_cipher = NULL
         WHERE raw_expires_at IS NOT NULL AND raw_expires_at <= ?`,
        )
        .run(now()).changes,
    );
  }

  status(): Record<string, number> {
    const taskRows = this.all<{ status: string; count: number }>(
      "SELECT status, count(*) AS count FROM tasks GROUP BY status",
    );
    const approval =
      this.get<CountRow>("SELECT count(*) AS count FROM approvals WHERE status = 'pending'")
        ?.count ?? 0;
    const outbox =
      this.get<CountRow>(
        `SELECT count(*) AS count FROM memory_outbox
       WHERE status IN ('pending', 'processing')
          OR (status = 'failed' AND attempt < 3)`,
      )?.count ?? 0;
    const deadLetters =
      this.get<CountRow>("SELECT count(*) AS count FROM dead_letters WHERE resolved_at IS NULL")
        ?.count ?? 0;
    return {
      ...Object.fromEntries(taskRows.map((row) => [`tasks_${row.status}`, row.count])),
      pending_approvals: approval,
      memory_outbox: outbox,
      dead_letters: deadLetters,
    };
  }
}
