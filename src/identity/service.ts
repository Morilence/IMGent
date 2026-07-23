import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PigeonStore } from "../storage/store.js";
import type { ActorRole } from "@agent-pigeon/contracts";

function now(): string {
  return new Date().toISOString();
}

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function shortCode(): string {
  return randomBytes(5).toString("hex").toUpperCase();
}

export class IdentityService {
  constructor(private readonly store: PigeonStore) {}

  isPaired(platformIdentityId: string): boolean {
    return (
      this.store.get<{ paired: number }>(
        "SELECT paired FROM platform_identities WHERE id = ?",
        platformIdentityId,
      )?.paired === 1
    );
  }

  createPairingCode(platformIdentityId: string, ttlMs = 10 * 60_000): string {
    const identity = this.store.get<{ id: string }>(
      "SELECT id FROM platform_identities WHERE id = ?",
      platformIdentityId,
    );
    if (!identity) throw new Error("平台身份不存在");
    const code = shortCode();
    this.store.run(
      `INSERT INTO pairing_codes(code_hash, platform_identity_id, expires_at)
       VALUES (?, ?, ?)`,
      hashCode(code),
      platformIdentityId,
      new Date(Date.now() + ttlMs).toISOString(),
    );
    return code;
  }

  confirmPairing(code: string): {
    platformIdentityId: string;
    principalId: string;
  } {
    return this.store.transaction(() => {
      const record = this.store.get<{
        platform_identity_id: string;
        expires_at: string;
        used_at: string | null;
      }>(
        "SELECT platform_identity_id, expires_at, used_at FROM pairing_codes WHERE code_hash = ?",
        hashCode(code.toUpperCase()),
      );
      if (!record || record.used_at) throw new Error("配对码无效或已使用");
      if (record.expires_at <= now()) throw new Error("配对码已过期");
      const identity = this.store.get<{ principal_id: string; agent_profile_id: string }>(
        "SELECT principal_id, agent_profile_id FROM platform_identities WHERE id = ?",
        record.platform_identity_id,
      );
      if (!identity) throw new Error("配对身份不存在");
      const timestamp = now();
      this.store.run(
        `UPDATE pairing_codes SET used_at = ?
         WHERE platform_identity_id = ? AND used_at IS NULL`,
        timestamp,
        record.platform_identity_id,
      );
      this.store.run(
        "UPDATE platform_identities SET paired = 1, updated_at = ? WHERE id = ?",
        timestamp,
        record.platform_identity_id,
      );
      this.audit("identity.paired", identity.agent_profile_id, identity.principal_id, undefined, {
        platformIdentityId: record.platform_identity_id,
      });
      return {
        platformIdentityId: record.platform_identity_id,
        principalId: identity.principal_id,
      };
    });
  }

  createBindingCode(platformIdentityId: string, ttlMs = 10 * 60_000): string {
    const identity = this.store.get<{ paired: number }>(
      "SELECT paired FROM platform_identities WHERE id = ?",
      platformIdentityId,
    );
    if (!identity || identity.paired !== 1) {
      throw new Error("只有已配对的私聊身份可以发起绑定");
    }
    const code = shortCode();
    this.store.run(
      `INSERT INTO binding_codes(code_hash, source_platform_identity_id, expires_at)
       VALUES (?, ?, ?)`,
      hashCode(code),
      platformIdentityId,
      new Date(Date.now() + ttlMs).toISOString(),
    );
    return code;
  }

  consumeBindingCode(
    code: string,
    targetPlatformIdentityId: string,
  ): { principalId: string; mergedPrincipalId?: string } {
    return this.store.transaction(() => {
      const binding = this.store.get<{
        source_platform_identity_id: string;
        expires_at: string;
        used_at: string | null;
      }>(
        `SELECT source_platform_identity_id, expires_at, used_at
         FROM binding_codes WHERE code_hash = ?`,
        hashCode(code.toUpperCase()),
      );
      if (!binding || binding.used_at) throw new Error("绑定码无效或已使用");
      if (binding.expires_at <= now()) throw new Error("绑定码已过期");
      if (binding.source_platform_identity_id === targetPlatformIdentityId) {
        throw new Error("不能绑定同一个平台身份");
      }
      const source = this.store.get<{
        principal_id: string;
        agent_profile_id: string;
        platform: string;
        bot_instance_id: string;
        platform_user_id: string;
      }>("SELECT * FROM platform_identities WHERE id = ?", binding.source_platform_identity_id);
      const target = this.store.get<{
        principal_id: string;
        agent_profile_id: string;
        platform: string;
        bot_instance_id: string;
        platform_user_id: string;
        paired: number;
      }>("SELECT * FROM platform_identities WHERE id = ?", targetPlatformIdentityId);
      if (!source || !target) throw new Error("绑定身份不存在");
      if (source.agent_profile_id !== target.agent_profile_id) {
        throw new Error("不能跨 AgentProfile 绑定身份");
      }

      const timestamp = now();
      this.store.run(
        `UPDATE binding_codes SET used_at = ?
         WHERE source_platform_identity_id = ? AND used_at IS NULL`,
        timestamp,
        binding.source_platform_identity_id,
      );
      if (source.principal_id === target.principal_id) {
        this.store.run(
          "UPDATE platform_identities SET paired = 1, updated_at = ? WHERE id = ?",
          timestamp,
          targetPlatformIdentityId,
        );
        return { principalId: source.principal_id };
      }

      this.mergePrincipal(target.principal_id, source.principal_id);
      this.store.run(
        "UPDATE platform_identities SET paired = 1, updated_at = ? WHERE id = ?",
        timestamp,
        targetPlatformIdentityId,
      );
      this.audit("identity.bound", source.agent_profile_id, source.principal_id, undefined, {
        source: {
          platform: source.platform,
          botInstanceId: source.bot_instance_id,
          platformUserId: source.platform_user_id,
        },
        target: {
          platform: target.platform,
          botInstanceId: target.bot_instance_id,
          platformUserId: target.platform_user_id,
        },
      });
      return {
        principalId: source.principal_id,
        mergedPrincipalId: target.principal_id,
      };
    });
  }

  private mergePrincipal(fromPrincipalId: string, toPrincipalId: string): void {
    const activeFacts = this.store.all<{
      id: string;
      agent_profile_id: string;
      scope_type: string;
      conversation_space_id: string | null;
      fact_key: string | null;
      updated_at: string;
    }>(
      `SELECT id, agent_profile_id, scope_type, conversation_space_id, fact_key, updated_at
       FROM memory_records WHERE principal_id = ? AND status = 'active'`,
      fromPrincipalId,
    );
    for (const record of activeFacts) {
      if (!record.fact_key) continue;
      const conflict = this.store.get<{ id: string; updated_at: string }>(
        `SELECT id, updated_at FROM memory_records
         WHERE agent_profile_id = ? AND scope_type = ?
           AND principal_id = ? AND COALESCE(conversation_space_id, '') = COALESCE(?, '')
           AND fact_key = ? AND status = 'active'`,
        record.agent_profile_id,
        record.scope_type,
        toPrincipalId,
        record.conversation_space_id,
        record.fact_key,
      );
      if (conflict) {
        const obsolete = conflict.updated_at >= record.updated_at ? record.id : conflict.id;
        this.store.run(
          "UPDATE memory_records SET status = 'superseded', updated_at = ? WHERE id = ?",
          now(),
          obsolete,
        );
        this.store.run("DELETE FROM memory_fts WHERE memory_id = ?", obsolete);
      }
    }
    this.store.run(
      "UPDATE platform_identities SET principal_id = ?, updated_at = ? WHERE principal_id = ?",
      toPrincipalId,
      now(),
      fromPrincipalId,
    );
    this.store.run(
      "UPDATE inbound_events SET principal_id = ? WHERE principal_id = ?",
      toPrincipalId,
      fromPrincipalId,
    );
    this.store.run(
      "UPDATE tasks SET principal_id = ? WHERE principal_id = ?",
      toPrincipalId,
      fromPrincipalId,
    );
    this.store.run(
      "UPDATE approvals SET principal_id = ? WHERE principal_id = ?",
      toPrincipalId,
      fromPrincipalId,
    );
    this.store.run(
      "UPDATE group_policies SET changed_by_principal_id = ? WHERE changed_by_principal_id = ?",
      toPrincipalId,
      fromPrincipalId,
    );
    this.store.run(
      `UPDATE group_authorizations SET authorized_by_principal_id = ?
       WHERE authorized_by_principal_id = ?`,
      toPrincipalId,
      fromPrincipalId,
    );
    this.store.run(
      "UPDATE memory_records SET principal_id = ?, updated_at = ? WHERE principal_id = ?",
      toPrincipalId,
      now(),
      fromPrincipalId,
    );
    const memberships = this.store.all<{
      conversation_space_id: string;
      platform_member_id: string | null;
      display_name: string | null;
      role: ActorRole;
      confirmed_at: string;
    }>("SELECT * FROM group_memberships WHERE principal_id = ?", fromPrincipalId);
    for (const membership of memberships) {
      this.store.run(
        `INSERT INTO group_memberships(
          conversation_space_id, principal_id, platform_member_id,
          display_name, role, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_space_id, principal_id) DO UPDATE SET
          platform_member_id = excluded.platform_member_id,
          display_name = excluded.display_name,
          role = excluded.role,
          confirmed_at = excluded.confirmed_at`,
        membership.conversation_space_id,
        toPrincipalId,
        membership.platform_member_id,
        membership.display_name,
        membership.role,
        membership.confirmed_at,
      );
    }
    this.store.run("DELETE FROM group_memberships WHERE principal_id = ?", fromPrincipalId);
    this.store.run("DELETE FROM principals WHERE id = ?", fromPrincipalId);
  }

  setPlatformFullCapability(conversationSpaceId: string, available: boolean): void {
    this.store.run(
      "UPDATE group_policies SET platform_full_capability = ? WHERE conversation_space_id = ?",
      available ? 1 : 0,
      conversationSpaceId,
    );
  }

  authorizeGroup(conversationSpaceId: string, authorizedByPrincipalId: string): void {
    this.store.transaction(() => {
      const group = this.store.get<{ agent_profile_id: string; kind: string }>(
        "SELECT agent_profile_id, kind FROM conversation_spaces WHERE id = ?",
        conversationSpaceId,
      );
      if (!group || group.kind !== "group") throw new Error("群会话不存在");
      const identity = this.store.get<{ count: number }>(
        `SELECT count(*) AS count FROM platform_identities
         WHERE principal_id = ? AND agent_profile_id = ? AND paired = 1`,
        authorizedByPrincipalId,
        group.agent_profile_id,
      );
      if (!identity?.count) {
        throw new Error("授权者未在该 AgentProfile 下配对");
      }
      this.store.run(
        `INSERT INTO group_authorizations(
          conversation_space_id, agent_profile_id,
          authorized_by_principal_id, created_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_space_id) DO UPDATE SET
          authorized_by_principal_id = excluded.authorized_by_principal_id,
          created_at = excluded.created_at`,
        conversationSpaceId,
        group.agent_profile_id,
        authorizedByPrincipalId,
        now(),
      );
      this.audit(
        "group.authorized",
        group.agent_profile_id,
        authorizedByPrincipalId,
        conversationSpaceId,
        {},
      );
    });
  }

  isGroupAuthorized(conversationSpaceId: string): boolean {
    return Boolean(
      this.store.get<{ conversation_space_id: string }>(
        "SELECT conversation_space_id FROM group_authorizations WHERE conversation_space_id = ?",
        conversationSpaceId,
      ),
    );
  }

  changeGroupMode(
    conversationSpaceId: string,
    principalId: string,
    role: ActorRole,
    mode: "triggered" | "full",
  ): void {
    this.store.transaction(() => {
      const membership = this.store.get<{ role: ActorRole }>(
        `SELECT role FROM group_memberships
         WHERE conversation_space_id = ? AND principal_id = ?`,
        conversationSpaceId,
        principalId,
      );
      const paired =
        this.store.get<{ count: number }>(
          `SELECT count(*) AS count FROM platform_identities
         WHERE principal_id = ? AND paired = 1`,
          principalId,
        )?.count ?? 0;
      const policy = this.store.get<{
        platform_full_capability: number;
        agent_profile_id: string;
      }>(
        `SELECT gp.platform_full_capability, cs.agent_profile_id
         FROM group_policies gp
         JOIN conversation_spaces cs ON cs.id = gp.conversation_space_id
         WHERE gp.conversation_space_id = ?`,
        conversationSpaceId,
      );
      if (!policy || paired === 0) throw new Error("发起者尚未配对或群不存在");
      const freshRole = membership?.role ?? role;
      if (freshRole !== "owner" && freshRole !== "admin") {
        throw new Error("只有平台可验证的群主或管理员可以切换采集模式");
      }
      if (mode === "full" && policy.platform_full_capability !== 1) {
        throw new Error("QQ BotInstance 缺少全量群消息事件权限");
      }
      this.store.run(
        `UPDATE group_policies
         SET mode = ?, changed_by_principal_id = ?, changed_at = ?
         WHERE conversation_space_id = ?`,
        mode,
        principalId,
        now(),
        conversationSpaceId,
      );
      this.audit(
        `group.ingestion.${mode}`,
        policy.agent_profile_id,
        principalId,
        conversationSpaceId,
        mode === "full"
          ? { retentionDays: 7, triggerBehavior: "context-only" }
          : { stopPersistingOrdinaryMessages: true },
      );
    });
  }

  audit(
    eventType: string,
    agentProfileId: string | undefined,
    principalId: string | undefined,
    conversationSpaceId: string | undefined,
    details: Record<string, unknown>,
  ): void {
    this.store.run(
      `INSERT INTO audit_events(
        id, agent_profile_id, principal_id, conversation_space_id,
        event_type, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      `audit_${randomUUID()}`,
      agentProfileId ?? null,
      principalId ?? null,
      conversationSpaceId ?? null,
      eventType,
      JSON.stringify(details),
      now(),
    );
  }
}
