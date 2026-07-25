import { IMGentError } from "@imgent/contracts";
import type { MemoryKind, MemoryOrigin, MemoryScope } from "./service.js";
import type { IMGentStore } from "../storage/store.js";

export const MEMORY_SCOPE_VALUES = [
  "personal_private",
  "private_episode",
  "group_shared",
  "group_member",
  "group_episode",
] as const satisfies readonly MemoryScope[];
export const MEMORY_ORIGIN_VALUES = [
  "explicit",
  "curated",
] as const satisfies readonly MemoryOrigin[];
export const MEMORY_STATUS_VALUES = ["active", "superseded", "forgotten"] as const;

export type MemoryRecordStatus = (typeof MEMORY_STATUS_VALUES)[number];

export interface MemoryListInput {
  scope?: MemoryScope;
  principal?: string;
  conversation?: string;
  origin?: MemoryOrigin;
  status?: MemoryRecordStatus;
  limit?: number;
  cursor?: string;
}

export interface MemoryAuditRecord {
  id: string;
  agentProfileId: string;
  scopeType: MemoryScope;
  principalId?: string;
  conversationSpaceId?: string;
  sourceMessageIds: string[];
  sourceTaskId?: string;
  origin: MemoryOrigin;
  kind: MemoryKind;
  factKey?: string;
  value: string;
  confidence: number;
  status: MemoryRecordStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface MemoryRecordPage {
  records: MemoryAuditRecord[];
  nextCursor?: string;
}

interface MemoryAuditRow {
  id: string;
  agent_profile_id: string;
  scope_type: MemoryScope;
  principal_id: string | null;
  conversation_space_id: string | null;
  source_message_ids: string;
  source_task_id: string | null;
  origin: MemoryOrigin;
  kind: MemoryKind;
  fact_key: string | null;
  value: string;
  confidence: number;
  status: MemoryRecordStatus;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface MemoryCursor {
  updatedAt: string;
  id: string;
}

export function listMemoryRecords(
  store: IMGentStore,
  input: MemoryListInput = {},
): MemoryRecordPage {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new IMGentError("CLI_USAGE_INVALID");
  }
  validateEnum(input.scope, MEMORY_SCOPE_VALUES);
  validateEnum(input.origin, MEMORY_ORIGIN_VALUES);
  validateEnum(input.status, MEMORY_STATUS_VALUES);
  validateIdentifier(input.principal);
  validateIdentifier(input.conversation);
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
  const where: string[] = [];
  const parameters: Array<string | number> = [];
  if (input.scope) {
    where.push("scope_type = ?");
    parameters.push(input.scope);
  }
  if (input.principal) {
    where.push("principal_id = ?");
    parameters.push(input.principal);
  }
  if (input.conversation) {
    where.push("conversation_space_id = ?");
    parameters.push(input.conversation);
  }
  if (input.origin) {
    where.push("origin = ?");
    parameters.push(input.origin);
  }
  if (input.status) {
    where.push("status = ?");
    parameters.push(input.status);
  }
  if (cursor) {
    where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  const rows = store.all<MemoryAuditRow>(
    `SELECT id, agent_profile_id, scope_type, principal_id,
            conversation_space_id, source_message_ids,
            source_task_id, origin, kind, fact_key, value, confidence, status,
            created_at, updated_at, expires_at
     FROM memory_records
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
    ...parameters,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const records = pageRows.map(auditRecord);
  const last = records.at(-1);
  return {
    records,
    ...(hasMore && last
      ? { nextCursor: encodeCursor({ updatedAt: last.updatedAt, id: last.id }) }
      : {}),
  };
}

export function getMemoryRecord(
  store: IMGentStore,
  memoryId: string,
): MemoryAuditRecord | undefined {
  if (!memoryId || memoryId.length > 256) throw new IMGentError("CLI_USAGE_INVALID");
  const row = store.get<MemoryAuditRow>(
    `SELECT id, agent_profile_id, scope_type, principal_id,
            conversation_space_id, source_message_ids,
            source_task_id, origin, kind, fact_key, value, confidence, status,
            created_at, updated_at, expires_at
     FROM memory_records WHERE id = ?`,
    memoryId,
  );
  return row ? auditRecord(row) : undefined;
}

export function memoryCurationStatus(store: IMGentStore): Record<string, unknown> {
  const total =
    store.get<{ count: number }>("SELECT count(*) AS count FROM memory_records")?.count ?? 0;
  return {
    records: {
      total,
      byScope: store.all(
        `SELECT scope_type AS scopeType, count(*) AS count
         FROM memory_records GROUP BY scope_type ORDER BY scope_type`,
      ),
      byStatus: store.all(
        `SELECT status, count(*) AS count
         FROM memory_records GROUP BY status ORDER BY status`,
      ),
      byOrigin: store.all(
        `SELECT origin, count(*) AS count
         FROM memory_records GROUP BY origin ORDER BY origin`,
      ),
    },
    curation: {
      outbox: store.all(
        `SELECT status, count(*) AS count
         FROM memory_outbox GROUP BY status ORDER BY status`,
      ),
      lastSucceededAt:
        store.get<{ value: string | null }>(
          `SELECT max(updated_at) AS value FROM memory_outbox
           WHERE status = 'succeeded'`,
        )?.value ?? null,
      lastFailedAt:
        store.get<{ value: string | null }>(
          `SELECT max(updated_at) AS value FROM memory_outbox
           WHERE status IN ('retry_wait', 'dead_letter')`,
        )?.value ?? null,
    },
  };
}

function auditRecord(row: MemoryAuditRow): MemoryAuditRecord {
  const sourceMessageIds = JSON.parse(row.source_message_ids) as unknown;
  if (
    !Array.isArray(sourceMessageIds) ||
    sourceMessageIds.some((value) => typeof value !== "string")
  ) {
    throw new IMGentError("STORAGE_UNAVAILABLE");
  }
  return {
    id: row.id,
    agentProfileId: row.agent_profile_id,
    scopeType: row.scope_type,
    ...(row.principal_id ? { principalId: row.principal_id } : {}),
    ...(row.conversation_space_id ? { conversationSpaceId: row.conversation_space_id } : {}),
    sourceMessageIds,
    ...(row.source_task_id ? { sourceTaskId: row.source_task_id } : {}),
    origin: row.origin,
    kind: row.kind,
    ...(row.fact_key ? { factKey: row.fact_key } : {}),
    value: row.value,
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

function encodeCursor(cursor: MemoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): MemoryCursor {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new IMGentError("CLI_USAGE_INVALID");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "id,updatedAt"
    ) {
      throw new Error("invalid cursor shape");
    }
    const candidate = parsed as Partial<MemoryCursor>;
    if (
      typeof candidate.updatedAt !== "string" ||
      Number.isNaN(Date.parse(candidate.updatedAt)) ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      candidate.id.length > 256
    ) {
      throw new Error("invalid cursor value");
    }
    return { updatedAt: candidate.updatedAt, id: candidate.id };
  } catch (error) {
    throw new IMGentError("CLI_USAGE_INVALID", { cause: error });
  }
}

function validateEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): asserts value is T | undefined {
  if (value !== undefined && !allowed.includes(value as T)) {
    throw new IMGentError("CLI_USAGE_INVALID");
  }
}

function validateIdentifier(value: string | undefined): void {
  if (value !== undefined && (value.length === 0 || value.length > 256)) {
    throw new IMGentError("CLI_USAGE_INVALID");
  }
}
