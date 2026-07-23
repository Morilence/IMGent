import { randomUUID } from "node:crypto";
import type { PigeonStore } from "../storage/store.js";

export type MemoryScope =
  "personal_private" | "private_episode" | "group_shared" | "group_member" | "group_episode";

export type MemoryKind = "fact" | "preference" | "decision" | "plan" | "episode";

export interface MemoryContext {
  agentProfileId: string;
  principalId: string;
  conversationSpaceId: string;
  conversationKey: string;
  conversationKind: "direct" | "group";
  sourceMessageIds: string[];
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
  confidence: number;
  updatedAt: string;
}

const FACT_KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SENSITIVE =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S+|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i;

function now(): string {
  return new Date().toISOString();
}

function ftsQuery(query: string): string {
  const tokens = query
    .normalize("NFKC")
    .split(/\s+/u)
    .map((token) => token.replaceAll('"', "").trim())
    .filter(Boolean)
    .slice(0, 16);
  return tokens.map((token) => `"${token}"`).join(" OR ");
}

export class MemoryService {
  constructor(private readonly store: PigeonStore) {}

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

    this.store.transaction(() => {
      if (input.factKey) {
        const existing = this.store.all<{ id: string }>(
          `SELECT id FROM memory_records
           WHERE agent_profile_id = ? AND scope_type = ?
             AND COALESCE(principal_id, '') = COALESCE(?, '')
             AND COALESCE(conversation_space_id, '') = COALESCE(?, '')
             AND fact_key = ? AND status = 'active'`,
          context.agentProfileId,
          scopeType,
          principalId ?? null,
          conversationSpaceId ?? null,
          input.factKey,
        );
        for (const record of existing) {
          this.store.run(
            "UPDATE memory_records SET status = 'superseded', updated_at = ? WHERE id = ?",
            timestamp,
            record.id,
          );
          this.store.run("DELETE FROM memory_fts WHERE memory_id = ?", record.id);
        }
      }
      this.store.run(
        `INSERT INTO memory_records(
          id, agent_profile_id, scope_type, principal_id, conversation_space_id,
          source_conversation_key, source_message_ids, kind, fact_key, value,
          confidence, status, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        id,
        context.agentProfileId,
        scopeType,
        principalId ?? null,
        conversationSpaceId ?? null,
        context.conversationKey,
        JSON.stringify(context.sourceMessageIds),
        input.kind,
        input.factKey ?? null,
        value,
        confidence,
        timestamp,
        timestamp,
        input.expiresAt ?? null,
      );
      this.store.run("INSERT INTO memory_fts(memory_id, value) VALUES (?, ?)", id, value);
    });

    return {
      id,
      scopeType,
      value,
      ...(input.factKey ? { factKey: input.factKey } : {}),
      kind: input.kind,
      confidence,
      updatedAt: timestamp,
    };
  }

  search(context: MemoryContext, query: string, limit = 12): MemoryRecord[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const scopeWhere =
      context.conversationKind === "direct"
        ? `(m.scope_type IN ('personal_private', 'private_episode')
            AND m.principal_id = ?)`
        : `((m.scope_type IN ('group_shared', 'group_episode')
              AND m.conversation_space_id = ?)
            OR (m.scope_type = 'group_member'
              AND m.conversation_space_id = ? AND m.principal_id = ?))`;
    const scopeParams =
      context.conversationKind === "direct"
        ? [context.principalId]
        : [context.conversationSpaceId, context.conversationSpaceId, context.principalId];
    type SearchRow = {
      id: string;
      scope_type: MemoryScope;
      value: string;
      fact_key: string | null;
      kind: MemoryKind;
      confidence: number;
      updated_at: string;
    };
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    const hanTerms = /[\p{Script=Han}]/u.test(query)
      ? query
          .normalize("NFKC")
          .split(/\s+/u)
          .map((term) => term.trim())
          .filter(Boolean)
          .slice(0, 8)
      : [];
    const rows =
      hanTerms.length > 0
        ? this.store.all<SearchRow>(
            `SELECT m.id, m.scope_type, m.value, m.fact_key, m.kind,
                    m.confidence, m.updated_at
             FROM memory_records m
             WHERE (${hanTerms.map(() => "m.value LIKE ? ESCAPE '\\'").join(" OR ")})
               AND m.agent_profile_id = ?
               AND m.status = 'active'
               AND (m.expires_at IS NULL OR m.expires_at > ?)
               AND ${scopeWhere}
             ORDER BY m.confidence DESC, m.updated_at DESC
             LIMIT ?`,
            ...hanTerms.map(
              (term) =>
                `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
            ),
            context.agentProfileId,
            now(),
            ...scopeParams,
            boundedLimit,
          )
        : this.store.all<SearchRow>(
            `SELECT m.id, m.scope_type, m.value, m.fact_key, m.kind,
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
    return rows.map((row) => ({
      id: row.id,
      scopeType: row.scope_type,
      value: row.value,
      ...(row.fact_key ? { factKey: row.fact_key } : {}),
      kind: row.kind,
      confidence: row.confidence,
      updatedAt: row.updated_at,
    }));
  }

  forget(context: MemoryContext, memoryId: string): boolean {
    return this.store.transaction(() => {
      const record = this.store.get<{
        scope_type: MemoryScope;
        principal_id: string | null;
        conversation_space_id: string | null;
      }>(
        `SELECT scope_type, principal_id, conversation_space_id
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
        fact_key: string | null;
        kind: MemoryKind;
        confidence: number;
      }>(
        `SELECT id, scope_type, principal_id, conversation_space_id,
                fact_key, kind, confidence
         FROM memory_records
         WHERE id = ? AND agent_profile_id = ? AND status = 'active'`,
        memoryId,
        context.agentProfileId,
      );
      if (!record || !this.canManage(context, record)) return undefined;
      const updatedAt = now();
      this.store.run(
        "UPDATE memory_records SET value = ?, updated_at = ? WHERE id = ?",
        normalized,
        updatedAt,
        memoryId,
      );
      this.store.run("DELETE FROM memory_fts WHERE memory_id = ?", memoryId);
      this.store.run(
        "INSERT INTO memory_fts(memory_id, value) VALUES (?, ?)",
        memoryId,
        normalized,
      );
      return {
        id: memoryId,
        scopeType: record.scope_type,
        value: normalized,
        ...(record.fact_key ? { factKey: record.fact_key } : {}),
        kind: record.kind,
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
    },
  ): boolean {
    if (record.scope_type === "personal_private" || record.scope_type === "private_episode") {
      return context.conversationKind === "direct" && record.principal_id === context.principalId;
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
}
