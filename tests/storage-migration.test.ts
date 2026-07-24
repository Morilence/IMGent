import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SecretBox } from "../src/security/secret-box.js";
import { IMGentStore } from "../src/storage/store.js";

test("schema v1 migrates to source-aware generated FTS5 search_text with a backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-migration-"));
  const path = join(directory, "state.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_meta(version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_meta(version) VALUES (1);
      CREATE TABLE tasks(id TEXT PRIMARY KEY) STRICT;
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
      assert.equal(store.get<{ version: number }>("SELECT version FROM schema_meta")?.version, 2);
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
