import { randomUUID } from "node:crypto";
import { memoryFtsQuery, memorySearchText } from "./search-text.js";
import type { IMGentStore } from "../storage/store.js";

export type MemoryScope =
  "personal_private" | "private_episode" | "group_shared" | "group_member" | "group_episode";

export type MemoryKind = "fact" | "preference" | "decision" | "plan" | "episode";
export type MemoryOrigin = "explicit" | "curated";

export interface MemoryContext {
  agentProfileId: string;
  principalId: string;
  conversationSpaceId: string;
  conversationKey: string;
  conversationKind: "direct" | "group";
  sourceMessageIds: string[];
  sourceTaskId?: string;
  origin?: MemoryOrigin;
  actorIsGroupAdmin?: boolean;
}

export interface RememberInput {
  target: "self" | "group" | "episode";
  kind: MemoryKind;
  factKey?: string;
  value: string;
  confidence?: number;
  expiresAt?: string;
}

export interface MemoryRecord {
  id: string;
  scopeType: MemoryScope;
  value: string;
  factKey?: string;
  kind: MemoryKind;
  origin: MemoryOrigin;
  confidence: number;
  updatedAt: string;
}

interface MemoryRecordRow {
  id: string;
  scope_type: MemoryScope;
  value: string;
  fact_key: string | null;
  kind: MemoryKind;
  origin: MemoryOrigin;
  confidence: number;
  updated_at: string;
}

const FACT_KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SENSITIVE =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S+|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i;

function now(): string {
  return new Date().toISOString();
}

export class MemoryService {
  constructor(private readonly store: IMGentStore) {}

  private scope(context: MemoryContext, target: RememberInput["target"]): MemoryScope {
    if (context.conversationKind === "direct") {
      if (target === "group") throw new Error("私聊不能写入群记忆");
      return target === "episode" ? "private_episode" : "personal_private";
    }
    if (target === "self") return "group_member";
    return target === "episode" ? "group_episode" : "group_shared";
  }

  remember(context: MemoryContext, input: RememberInput): MemoryRecord {
    const value = input.value.trim();
    if (!value || value.length > 4_000) throw new Error("记忆内容长度无效");
    if (SENSITIVE.test(value)) throw new Error("凭据、token、密码或私钥不能写入长期记忆");
    if (input.factKey && !FACT_KEY.test(input.factKey)) {
      throw new Error("factKey 格式无效");
    }
    if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) {
      throw new Error("expiresAt 格式无效");
    }
    const scopeType = this.scope(context, input.target);
    const principalId =
      scopeType === "personal_private" ||
      scopeType === "private_episode" ||
      scopeType === "group_member"
        ? context.principalId
        : undefined;
    const conversationSpaceId =
      scopeType === "group_shared" || scopeType === "group_member" || scopeType === "group_episode"
        ? context.conversationSpaceId
        : undefined;
    const id = `memory_${randomUUID()}`;
    const timestamp = now();
    const confidence = Math.max(0, Math.min(1, input.confidence ?? 1));
    const origin = context.origin ?? "explicit";

    return this.store.transaction(() => {
      type ExistingRow = {
        id: string;
        scope_type: MemoryScope;
        value: string;
        fact_key: string | null;
        kind: MemoryKind;
        origin: MemoryOrigin;
        confidence: number;
        updated_at: string;
      };
      const sourced =
        context.sourceTaskId && input.factKey
          ? this.store.get<ExistingRow>(
              `SELECT id, scope_type, value, fact_key, kind, origin, confidence, updated_at
               FROM memory_records
               WHERE source_task_id = ? AND scope_type = ?
                 AND COALESCE(principal_id, '') = COALESCE(?, '')
                 AND COALESCE(conversation_space_id, '') = COALESCE(?, '')
                 AND (scope_type <> 'private_episode' OR source_conversation_key = ?)
                 AND fact_key = ?`,
              context.sourceTaskId,
              scopeType,
              principalId ?? null,
              conversationSpaceId ?? null,
              context.conversationKey,
              input.factKey,
            )
          : undefined;
      if (sourced) return memoryRecord(sourced);
      const sameFact = input.factKey
        ? this.store.all<{ id: string }>(
            `SELECT id FROM memory_records
             WHERE agent_profile_id = ? AND scope_type = ?
               AND COALESCE(principal_id, '') = COALESCE(?, '')
               AND COALESCE(conversation_space_id, '') = COALESCE(?, '')
               AND (scope_type <> 'private_episode' OR source_conversation_key = ?)
               AND fact_key = ? AND status = 'active'`,
            context.agentProfileId,
            scopeType,
            principalId ?? null,
            conversationSpaceId ?? null,
            context.conversationKey,
            input.factKey,
          )
        : [];
      const duplicate = this.store.get<{
        id: string;
        scope_type: MemoryScope;
        value: string;
        fact_key: string | null;
        kind: MemoryKind;
        origin: MemoryOrigin;
        confidence: number;
        updated_at: string;
      }>(
        `SELECT id, scope_type, value, fact_key, kind, origin, confidence, updated_at
         FROM memory_records
         WHERE agent_profile_id = ? AND scope_type = ?
           AND COALESCE(principal_id, '') = COALESCE(?, '')
           AND COALESCE(conversation_space_id, '') = COALESCE(?, '')
           AND (scope_type <> 'private_episode' OR source_conversation_key = ?)
           AND value = ? AND status = 'active'`,
        context.agentProfileId,
        scopeType,
        principalId ?? null,
        conversationSpaceId ?? null,
        context.conversationKey,
        value,
      );
      for (const record of sameFact) {
        if (record.id === duplicate?.id) continue;
        this.store.run(
          "UPDATE memory_records SET status = 'superseded', updated_at = ? WHERE id = ?",
          timestamp,
          record.id,
        );
        this.store.run("DELETE FROM memory_fts WHERE memory_id = ?", record.id);
      }
      if (duplicate) return memoryRecord(duplicate);
      this.store.run(
        `INSERT INTO memory_records(
          id, agent_profile_id, scope_type, principal_id, conversation_space_id,
          source_conversation_key, source_message_ids, source_task_id, origin,
          kind, fact_key, value, confidence, status, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        id,
        context.agentProfileId,
        scopeType,
        principalId ?? null,
        conversationSpaceId ?? null,
        context.conversationKey,
        JSON.stringify(context.sourceMessageIds),
        context.sourceTaskId ?? null,
        origin,
        input.kind,
        input.factKey ?? null,
        value,
        confidence,
        timestamp,
        timestamp,
        input.expiresAt ?? null,
      );
      this.store.run(
        "INSERT INTO memory_fts(memory_id, search_text) VALUES (?, ?)",
        id,
        memorySearchText(value),
      );
      return {
        id,
        scopeType,
        value,
        ...(input.factKey ? { factKey: input.factKey } : {}),
        kind: input.kind,
        origin,
        confidence,
        updatedAt: timestamp,
      };
    });
  }

  search(context: MemoryContext, query: string, limit = 12): MemoryRecord[] {
    const match = memoryFtsQuery(query);
    if (!match) return [];
    const scopeWhere =
      context.conversationKind === "direct"
        ? `((m.scope_type = 'personal_private' AND m.principal_id = ?)
            OR (m.scope_type = 'private_episode' AND m.principal_id = ?
                AND m.source_conversation_key = ?))`
        : `((m.scope_type IN ('group_shared', 'group_episode')
              AND m.conversation_space_id = ?)
            OR (m.scope_type = 'group_member'
              AND m.conversation_space_id = ? AND m.principal_id = ?))`;
    const scopeParams =
      context.conversationKind === "direct"
        ? [context.principalId, context.principalId, context.conversationKey]
        : [context.conversationSpaceId, context.conversationSpaceId, context.principalId];
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    const rows = this.store.all<MemoryRecordRow>(
      `SELECT m.id, m.scope_type, m.value, m.fact_key, m.kind, m.origin,
              m.confidence, m.updated_at
       FROM memory_fts f
       JOIN memory_records m ON m.id = f.memory_id
       WHERE memory_fts MATCH ?
         AND m.agent_profile_id = ?
         AND m.status = 'active'
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND ${scopeWhere}
       ORDER BY bm25(memory_fts), m.confidence DESC, m.updated_at DESC
       LIMIT ?`,
      match,
      context.agentProfileId,
      now(),
      ...scopeParams,
      boundedLimit,
    );
    return rows.map(memoryRecord);
  }

  recall(context: MemoryContext, query: string): MemoryRecord[] {
    const baseline = this.baseline(context);
    const relevant = query.trim() ? this.search(context, query, 8) : [];
    const episodes = this.recentEpisodes(context, 2);
    const merged: MemoryRecord[] = [];
    const seen = new Set<string>();
    for (const record of [...baseline, ...relevant, ...episodes]) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      merged.push(record);
      if (merged.length === 12) break;
    }
    return merged;
  }

  forget(context: MemoryContext, memoryId: string): boolean {
    return this.store.transaction(() => {
      const record = this.store.get<{
        scope_type: MemoryScope;
        principal_id: string | null;
        conversation_space_id: string | null;
        source_conversation_key: string;
      }>(
        `SELECT scope_type, principal_id, conversation_space_id, source_conversation_key
         FROM memory_records
         WHERE id = ? AND agent_profile_id = ? AND status = 'active'`,
        memoryId,
        context.agentProfileId,
      );
      if (!record || !this.canManage(context, record)) return false;
      this.store.run(
        "UPDATE memory_records SET status = 'forgotten', updated_at = ? WHERE id = ?",
        now(),
        memoryId,
      );
      this.store.run("DELETE FROM memory_fts WHERE memory_id = ?", memoryId);
      return true;
    });
  }

  update(context: MemoryContext, memoryId: string, value: string): MemoryRecord | undefined {
    const normalized = value.trim();
    if (!normalized || normalized.length > 4_000) {
      throw new Error("记忆内容长度无效");
    }
    if (SENSITIVE.test(normalized)) {
      throw new Error("凭据、token、密码或私钥不能写入长期记忆");
    }
    return this.store.transaction(() => {
      const record = this.store.get<{
        id: string;
        scope_type: MemoryScope;
        principal_id: string | null;
        conversation_space_id: string | null;
        source_conversation_key: string;
        fact_key: string | null;
        kind: MemoryKind;
        origin: MemoryOrigin;
        confidence: number;
      }>(
        `SELECT id, scope_type, principal_id, conversation_space_id, source_conversation_key,
                fact_key, kind, origin, confidence
         FROM memory_records
         WHERE id = ? AND agent_profile_id = ? AND status = 'active'`,
        memoryId,
        context.agentProfileId,
      );
      if (!record || !this.canManage(context, record)) return undefined;
      const duplicate = this.store.get<{ id: string }>(
        `SELECT id FROM memory_records
         WHERE agent_profile_id = ? AND scope_type = ?
           AND COALESCE(principal_id, '') = COALESCE(?, '')
           AND COALESCE(conversation_space_id, '') = COALESCE(?, '')
           AND (scope_type <> 'private_episode' OR source_conversation_key = ?)
           AND value = ? AND status = 'active' AND id <> ?`,
        context.agentProfileId,
        record.scope_type,
        record.principal_id,
        record.conversation_space_id,
        record.source_conversation_key,
        normalized,
        memoryId,
      );
      if (duplicate) throw new Error("相同作用域中已存在完全相同的 active 记忆");
      const updatedAt = now();
      this.store.run(
        "UPDATE memory_records SET value = ?, updated_at = ? WHERE id = ?",
        normalized,
        updatedAt,
        memoryId,
      );
      this.store.run("DELETE FROM memory_fts WHERE memory_id = ?", memoryId);
      this.store.run(
        "INSERT INTO memory_fts(memory_id, search_text) VALUES (?, ?)",
        memoryId,
        memorySearchText(normalized),
      );
      return {
        id: memoryId,
        scopeType: record.scope_type,
        value: normalized,
        ...(record.fact_key ? { factKey: record.fact_key } : {}),
        kind: record.kind,
        origin: record.origin,
        confidence: record.confidence,
        updatedAt,
      };
    });
  }

  private canManage(
    context: MemoryContext,
    record: {
      scope_type: MemoryScope;
      principal_id: string | null;
      conversation_space_id: string | null;
      source_conversation_key: string;
    },
  ): boolean {
    if (record.scope_type === "personal_private") {
      return context.conversationKind === "direct" && record.principal_id === context.principalId;
    }
    if (record.scope_type === "private_episode") {
      return (
        context.conversationKind === "direct" &&
        record.principal_id === context.principalId &&
        record.source_conversation_key === context.conversationKey
      );
    }
    if (record.scope_type === "group_member") {
      return (
        context.conversationKind === "group" &&
        record.conversation_space_id === context.conversationSpaceId &&
        record.principal_id === context.principalId
      );
    }
    return (
      context.conversationKind === "group" &&
      record.conversation_space_id === context.conversationSpaceId &&
      context.actorIsGroupAdmin === true
    );
  }

  renderContext(records: readonly MemoryRecord[], maxChars = 6_000): string[] {
    const result: string[] = [];
    let used = 0;
    for (const memory of records) {
      const line = `[${memory.scopeType}/${memory.kind}] ${memory.value}`;
      if (used + line.length > maxChars) break;
      result.push(line);
      used += line.length;
    }
    return result;
  }

  private baseline(context: MemoryContext): MemoryRecord[] {
    const current = now();
    if (context.conversationKind === "direct") {
      return this.store
        .all<MemoryRecordRow>(
          `SELECT id, scope_type, value, fact_key, kind, origin, confidence, updated_at
           FROM memory_records
           WHERE agent_profile_id = ?
             AND scope_type = 'personal_private'
             AND principal_id = ?
             AND kind IN ('fact', 'preference', 'decision', 'plan')
             AND status = 'active'
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY confidence DESC, updated_at DESC, id DESC
           LIMIT 6`,
          context.agentProfileId,
          context.principalId,
          current,
        )
        .map(memoryRecord);
    }
    const member = this.store
      .all<MemoryRecordRow>(
        `SELECT id, scope_type, value, fact_key, kind, origin, confidence, updated_at
         FROM memory_records
         WHERE agent_profile_id = ?
           AND scope_type = 'group_member'
           AND conversation_space_id = ?
           AND principal_id = ?
           AND kind IN ('fact', 'preference', 'decision', 'plan')
           AND status = 'active'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY confidence DESC, updated_at DESC, id DESC
         LIMIT 3`,
        context.agentProfileId,
        context.conversationSpaceId,
        context.principalId,
        current,
      )
      .map(memoryRecord);
    const shared = this.store
      .all<MemoryRecordRow>(
        `SELECT id, scope_type, value, fact_key, kind, origin, confidence, updated_at
         FROM memory_records
         WHERE agent_profile_id = ?
           AND scope_type = 'group_shared'
           AND conversation_space_id = ?
           AND kind IN ('fact', 'preference', 'decision', 'plan')
           AND status = 'active'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY confidence DESC, updated_at DESC, id DESC
         LIMIT 3`,
        context.agentProfileId,
        context.conversationSpaceId,
        current,
      )
      .map(memoryRecord);
    return [...member, ...shared];
  }

  private recentEpisodes(context: MemoryContext, limit: number): MemoryRecord[] {
    const current = now();
    const rows =
      context.conversationKind === "direct"
        ? this.store.all<MemoryRecordRow>(
            `SELECT id, scope_type, value, fact_key, kind, origin, confidence, updated_at
             FROM memory_records
             WHERE agent_profile_id = ?
               AND scope_type = 'private_episode'
               AND principal_id = ?
               AND source_conversation_key = ?
               AND status = 'active'
               AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY updated_at DESC, id DESC
             LIMIT ?`,
            context.agentProfileId,
            context.principalId,
            context.conversationKey,
            current,
            limit,
          )
        : this.store.all<MemoryRecordRow>(
            `SELECT id, scope_type, value, fact_key, kind, origin, confidence, updated_at
             FROM memory_records
             WHERE agent_profile_id = ?
               AND scope_type = 'group_episode'
               AND conversation_space_id = ?
               AND status = 'active'
               AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY updated_at DESC, id DESC
             LIMIT ?`,
            context.agentProfileId,
            context.conversationSpaceId,
            current,
            limit,
          );
    return rows.map(memoryRecord);
  }
}

function memoryRecord(row: MemoryRecordRow): MemoryRecord {
  return {
    id: row.id,
    scopeType: row.scope_type,
    value: row.value,
    ...(row.fact_key ? { factKey: row.fact_key } : {}),
    kind: row.kind,
    origin: row.origin,
    confidence: row.confidence,
    updatedAt: row.updated_at,
  };
}
