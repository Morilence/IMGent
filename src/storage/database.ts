import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IMGentError } from "@imgent/contracts";
import { SCHEMA, SCHEMA_VERSION } from "./migrations.js";

export async function openDatabase(path: string): Promise<DatabaseSync> {
  let database: DatabaseSync | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      defensive: true,
      timeout: 5_000,
    });
  } catch (error) {
    database?.close();
    throw new IMGentError("STORAGE_UNAVAILABLE", {
      cause: error,
      diagnostic: { path },
    });
  }

  const initialized = database
    .prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
    )
    .get() as unknown as { count: number };
  if (initialized.count === 0) {
    await configureDatabase(database, path);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(SCHEMA);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw new IMGentError("STORAGE_UNAVAILABLE", {
        cause: error,
        diagnostic: { operation: "initialize schema" },
      });
    }
  } else {
    const version = database.prepare("SELECT version FROM schema_meta").get() as
      { version: number } | undefined;
    if (version?.version !== SCHEMA_VERSION) {
      database.close();
      throw new IMGentError("STORAGE_SCHEMA_UNSUPPORTED", {
        diagnostic: {
          databaseVersion: version?.version ?? "unknown",
          supportedVersion: SCHEMA_VERSION,
        },
      });
    }
    await configureDatabase(database, path);
  }

  const fts = database
    .prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
    .get() as unknown as { enabled: number };
  if (fts.enabled !== 1) {
    database.close();
    throw new IMGentError("STORAGE_UNAVAILABLE", {
      diagnostic: { reason: "FTS5 unavailable" },
    });
  }
  database.prepare("INSERT INTO memory_fts(search_text) VALUES (?)").run("tokenizer-check");
  database.prepare("DELETE FROM memory_fts WHERE search_text = ?").run("tokenizer-check");
  return database;
}

async function configureDatabase(database: DatabaseSync, path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  } catch (error) {
    database.close();
    throw new IMGentError("STORAGE_UNAVAILABLE", {
      cause: error,
      diagnostic: { path },
    });
  }
}
