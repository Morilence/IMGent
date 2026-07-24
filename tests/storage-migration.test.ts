import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { IMGentError } from "@imgent/contracts";
import { SecretBox } from "../src/security/secret-box.js";
import { IMGentStore } from "../src/storage/store.js";

test("schema v1 migrates through v3 with data preservation and a backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-migration-"));
  const path = join(directory, "state.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_meta(version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_meta(version) VALUES (1);
      CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        agent_profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(id, agent_profile_id)
      ) STRICT;
      INSERT INTO principals(id, agent_profile_id, created_at)
      VALUES ('principal-1', 'main', '2026-01-01T00:00:00.000Z');
      CREATE TABLE conversation_spaces (
        id TEXT PRIMARY KEY
      ) STRICT;
      INSERT INTO conversation_spaces(id) VALUES ('space-1');
      CREATE TABLE inbound_events (
        id TEXT PRIMARY KEY
      ) STRICT;
      INSERT INTO inbound_events(id) VALUES ('event-1');
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        inbound_event_id TEXT NOT NULL,
        agent_profile_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        conversation_space_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        dangerous_side_effect_started INTEGER NOT NULL DEFAULT 0,
        final_text TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX tasks_fifo_idx ON tasks(conversation_key, status, created_at);
      CREATE INDEX tasks_status_idx ON tasks(status, created_at);
      INSERT INTO tasks(
        id, inbound_event_id, agent_profile_id, principal_id,
        conversation_space_id, conversation_key, idempotency_key, status,
        attempt, dangerous_side_effect_started, error_code, error_message,
        created_at, updated_at
      ) VALUES (
        'legacy-task', 'event-1', 'main', 'principal-1', 'space-1',
        'legacy-conversation', 'legacy-idempotency', 'failed', 2, 0,
        'VENDOR_FAILURE', 'raw vendor error token=legacy-secret',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE memory_outbox (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO memory_outbox(
        id, task_id, status, attempt, next_attempt_at, error_message,
        created_at, updated_at
      ) VALUES (
        'legacy-curation', 'legacy-task', 'failed', 1,
        '2026-01-01T00:00:00.000Z', 'raw curation error',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE outbound_messages (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        bot_instance_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        reply_context_cipher BLOB,
        platform_message_id TEXT,
        send_mode TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX outbound_status_idx ON outbound_messages(status, created_at);
      INSERT INTO outbound_messages(
        id, task_id, bot_instance_id, idempotency_key, status, payload_json,
        attempt, error_code, created_at, updated_at
      ) VALUES (
        'legacy-outbound', 'legacy-task', 'qq-main', 'legacy-outbound-key',
        'failed', '{"parts":[]}', 1, 'RAW_HTTP_500',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE dead_letters (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        bot_instance_id TEXT,
        reference_id TEXT,
        diagnostic_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;
      INSERT INTO dead_letters(
        id, category, diagnostic_json, created_at
      ) VALUES (
        'legacy-dead', 'legacy', '{"token":"legacy-secret","sql":"SELECT secret"}',
        '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE memory_records (
        id TEXT PRIMARY KEY,
        agent_profile_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        principal_id TEXT,
        conversation_space_id TEXT,
        source_conversation_key TEXT NOT NULL,
        source_message_ids TEXT NOT NULL,
        kind TEXT NOT NULL,
        fact_key TEXT,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      ) STRICT;
      INSERT INTO memory_records(
        id, agent_profile_id, scope_type, principal_id, conversation_space_id,
        source_conversation_key, source_message_ids, kind, fact_key, value,
        confidence, status, created_at, updated_at
      ) VALUES (
        'legacy-memory', 'main', 'personal_private', 'principal-1', NULL,
        'conversation', '[]', 'preference', 'reply.style', '偏好 release 简洁说明',
        1, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      CREATE UNIQUE INDEX memory_active_fact_idx
        ON memory_records(
          agent_profile_id,
          scope_type,
          COALESCE(principal_id, ''),
          COALESCE(conversation_space_id, ''),
          fact_key
        )
        WHERE status = 'active' AND fact_key IS NOT NULL;
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        memory_id UNINDEXED,
        value,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO memory_fts(memory_id, value)
      VALUES ('legacy-memory', '偏好 release 简洁说明');
    `);
    legacy.close();

    const store = await IMGentStore.open(path, new SecretBox(randomBytes(32)));
    try {
      assert.equal(store.get<{ version: number }>("SELECT version FROM schema_meta")?.version, 3);
      assert.deepEqual(
        {
          ...store.get<{
            source_task_id: string | null;
            origin: string;
          }>("SELECT source_task_id, origin FROM memory_records WHERE id = 'legacy-memory'"),
        },
        { source_task_id: null, origin: "explicit" },
      );
      const indexed = store.get<{ memory_id: string }>(
        `SELECT memory_id FROM memory_fts
         WHERE memory_fts MATCH '"简洁" OR "release"'`,
      );
      assert.equal(indexed?.memory_id, "legacy-memory");
      assert.equal(
        JSON.parse(
          store.get<{ error_json: string }>(
            "SELECT error_json FROM tasks WHERE id = 'legacy-task'",
          )!.error_json,
        ).code,
        "LEGACY_RECORDED_ERROR",
      );
      assert.deepEqual(
        {
          ...store.get<{ status: string; code: string }>(
            `SELECT status, json_extract(last_error_json, '$.code') AS code
           FROM outbound_messages WHERE id = 'legacy-outbound'`,
          ),
        },
        { status: "retry_wait", code: "LEGACY_RECORDED_ERROR" },
      );
      assert.deepEqual(
        {
          ...store.get<{ status: string; code: string }>(
            `SELECT status, json_extract(last_error_json, '$.code') AS code
             FROM memory_outbox WHERE id = 'legacy-curation'`,
          ),
        },
        { status: "retry_wait", code: "LEGACY_RECORDED_ERROR" },
      );
      assert.equal(
        store.get<{ diagnostic_json: string }>(
          "SELECT diagnostic_json FROM dead_letters WHERE id = 'legacy-dead'",
        )?.diagnostic_json,
        '{"legacy":true}',
      );
      assert.deepEqual(store.all("PRAGMA foreign_key_check"), []);
      const taskColumns = store
        .all<{ name: string }>("PRAGMA table_info(tasks)")
        .map((column) => column.name);
      assert.equal(taskColumns.includes("error_code"), false);
      assert.equal(taskColumns.includes("error_message"), false);
      assert.equal(taskColumns.includes("error_json"), true);
    } finally {
      store.close();
    }
    const backupName = (await readdir(directory)).find((name) => name.includes(".pre-migrate-"));
    assert.ok(backupName);
    assert.equal((await stat(join(directory, backupName))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed v2 to v3 migration rolls back and keeps a pre-migration backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-migration-rollback-"));
  const path = join(directory, "state.sqlite");
  try {
    const broken = new DatabaseSync(path);
    broken.exec(`
      CREATE TABLE schema_meta(version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_meta(version) VALUES (2);
    `);
    broken.close();

    await assert.rejects(
      IMGentStore.open(path, new SecretBox(randomBytes(32))),
      (error: unknown) => error instanceof IMGentError && error.code === "STORAGE_MIGRATION_FAILED",
    );

    const preserved = new DatabaseSync(path);
    try {
      assert.equal(
        (
          preserved.prepare("SELECT version FROM schema_meta").get() as unknown as {
            version: number;
          }
        ).version,
        2,
      );
      assert.equal(
        (
          preserved
            .prepare(
              `SELECT count(*) AS count FROM sqlite_master
               WHERE type = 'table' AND name = 'tasks_v3'`,
            )
            .get() as unknown as { count: number }
        ).count,
        0,
      );
    } finally {
      preserved.close();
    }
    const backupName = (await readdir(directory)).find((name) => name.includes(".pre-migrate-"));
    assert.ok(backupName);
    assert.equal((await stat(join(directory, backupName))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
