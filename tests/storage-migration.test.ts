import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { IMGentError } from "@imgent/contracts";
import { SecretBox } from "../src/security/secret-box.js";
import { SCHEMA_VERSION } from "../src/storage/migrations.js";
import { IMGentStore } from "../src/storage/store.js";

test("fresh storage creates schema 6 with Principal workspaces and due-work indexes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-schema-"));
  const path = join(directory, "state.sqlite");
  try {
    const store = await IMGentStore.open(path, new SecretBox(randomBytes(32)));
    try {
      assert.equal(
        store.get<{ version: number }>("SELECT version FROM schema_meta")?.version,
        SCHEMA_VERSION,
      );
      for (const [table, index] of [
        ["tasks", "tasks_claim_idx"],
        ["memory_outbox", "memory_outbox_claim_idx"],
        ["outbound_messages", "outbound_claim_idx"],
        ["schedules", "schedules_due_idx"],
      ] as const) {
        const indexes = store.all<{ name: string }>(`PRAGMA index_list(${table})`);
        assert.ok(
          indexes.some((entry) => entry.name === index),
          `${table} is missing ${index}`,
        );
      }
      for (const [sql, index] of [
        [
          `SELECT id FROM tasks
           WHERE status IN ('queued', 'retry_wait')
             AND (status = 'queued' OR next_attempt_at <= CURRENT_TIMESTAMP)
           ORDER BY created_at LIMIT 1`,
          "tasks_claim_idx",
        ],
        [
          `SELECT id FROM memory_outbox
           WHERE status IN ('pending', 'retry_wait')
             AND attempt < 3
             AND next_attempt_at <= CURRENT_TIMESTAMP
           ORDER BY created_at LIMIT 1`,
          "memory_outbox_claim_idx",
        ],
        [
          `SELECT id FROM outbound_messages
           WHERE status IN ('pending', 'retry_wait')
             AND attempt < 3
             AND next_attempt_at <= CURRENT_TIMESTAMP
           ORDER BY created_at LIMIT 1`,
          "outbound_claim_idx",
        ],
      ] as const) {
        const plan = store
          .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
          .map((entry) => entry.detail)
          .join("\n");
        assert.match(plan, new RegExp(index), `${index} is not used:\n${plan}`);
      }
      assert.equal(
        store
          .all<{ name: string }>("PRAGMA table_info(approvals)")
          .some((column) => column.name === "agent_profile_id"),
        false,
      );
      assert.equal(
        store
          .all<{ name: string }>("PRAGMA table_info(agent_sessions)")
          .some((column) => column.name === "agent_profile_id"),
        false,
      );
      assert.equal(
        store
          .all<{ name: string }>("PRAGMA table_info(principals)")
          .some((column) => column.name === "workspace"),
        true,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy schemas are rejected without mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imgent-legacy-schema-"));
  const path = join(directory, "state.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_meta(version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_meta(version) VALUES (5);
    `);
    legacy.close();
    const bytesBefore = await readFile(path);
    const modeBefore = (await stat(path)).mode;

    await assert.rejects(
      IMGentStore.open(path, new SecretBox(randomBytes(32))),
      (error: unknown) =>
        error instanceof IMGentError && error.code === "STORAGE_SCHEMA_UNSUPPORTED",
    );

    const unchanged = new DatabaseSync(path);
    assert.equal(
      (unchanged.prepare("SELECT version FROM schema_meta").get() as { version: number }).version,
      5,
    );
    unchanged.close();
    assert.deepEqual(await readFile(path), bytesBefore);
    assert.equal((await stat(path)).mode, modeBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
