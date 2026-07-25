import type { IMGentStore } from "../storage/store.js";

export function persistentStatus(store: IMGentStore): Record<string, unknown> {
  return {
    database: databaseStatus(store),
    transports: store.all(
      `SELECT bot_instance_id AS botInstanceId,
              checkpoint_key AS checkpointKey, value, updated_at AS updatedAt
       FROM transport_checkpoints
       ORDER BY bot_instance_id, checkpoint_key`,
    ),
    lastInboundByBot: store.all(
      `SELECT bot_instance_id AS botInstanceId,
              max(received_at) AS lastReceivedAt
       FROM inbound_events GROUP BY bot_instance_id
       ORDER BY bot_instance_id`,
    ),
    groups: store.all(
      `SELECT cs.bot_instance_id AS botInstanceId, gp.mode,
              gp.platform_full_capability AS platformFullCapability,
              count(*) AS count
       FROM group_policies gp
       JOIN conversation_spaces cs
         ON cs.id = gp.conversation_space_id
       GROUP BY cs.bot_instance_id, gp.mode, gp.platform_full_capability
       ORDER BY cs.bot_instance_id, gp.mode`,
    ),
    oldestWaitingTask:
      store.get(
        `SELECT id, conversation_key AS conversationKey, status,
                created_at AS createdAt
         FROM tasks
         WHERE status IN ('queued', 'active', 'retry_wait', 'waiting_approval')
         ORDER BY created_at LIMIT 1`,
      ) ?? null,
    schedules: store.all(
      `SELECT status, count(*) AS count FROM schedules
       GROUP BY status ORDER BY status`,
    ),
    nextSchedule:
      store.get(
        `SELECT id, name, next_run_at AS nextRunAt FROM schedules
         WHERE status = 'active' AND next_run_at IS NOT NULL
         ORDER BY next_run_at LIMIT 1`,
      ) ?? null,
  };
}

function databaseStatus(store: IMGentStore): Record<string, number> {
  const taskRows = store.all<{ status: string; count: number }>(
    "SELECT status, count(*) AS count FROM tasks GROUP BY status",
  );
  const count = (sql: string) => store.get<{ count: number }>(sql)?.count ?? 0;
  return {
    ...Object.fromEntries(taskRows.map((row) => [`tasks_${row.status}`, row.count])),
    pending_approvals: count("SELECT count(*) AS count FROM approvals WHERE status = 'pending'"),
    memory_outbox: count(
      `SELECT count(*) AS count FROM memory_outbox
       WHERE status IN ('pending', 'processing')
          OR (status = 'retry_wait' AND attempt < 3)`,
    ),
    dead_letters: count("SELECT count(*) AS count FROM dead_letters WHERE resolved_at IS NULL"),
  };
}

export function identities(store: IMGentStore): unknown[] {
  return store.all(
    `SELECT pi.id AS platformIdentityId, pi.agent_profile_id AS agentProfileId,
            pi.platform, pi.bot_instance_id AS botInstanceId,
            pi.platform_user_id AS platformUserId, pi.principal_id AS principalId,
            pi.display_name AS displayName, pi.paired, p.workspace
     FROM platform_identities pi
     JOIN principals p ON p.id = pi.principal_id
     ORDER BY pi.created_at`,
  );
}

export function groups(store: IMGentStore): unknown[] {
  return store.all(
    `SELECT cs.id AS conversationSpaceId, cs.agent_profile_id AS agentProfileId,
            cs.bot_instance_id AS botInstanceId,
            cs.platform_conversation_id AS platformConversationId,
            gp.mode, gp.platform_full_capability AS platformFullCapability,
            CASE WHEN ga.conversation_space_id IS NULL THEN 0 ELSE 1 END AS authorized
     FROM conversation_spaces cs
     JOIN group_policies gp ON gp.conversation_space_id = cs.id
     LEFT JOIN group_authorizations ga ON ga.conversation_space_id = cs.id
     WHERE cs.kind = 'group'
     ORDER BY cs.created_at`,
  );
}

export function conversations(store: IMGentStore): Array<Record<string, unknown>> {
  return store
    .all<{
      id: string;
      agentProfileId: string;
      platform: string;
      botInstanceId: string;
      kind: "direct" | "group";
      platformConversationId: string;
    }>(
      `SELECT id, agent_profile_id AS agentProfileId, platform,
              bot_instance_id AS botInstanceId, kind,
              platform_conversation_id AS platformConversationId
       FROM conversation_spaces ORDER BY created_at`,
    )
    .map((space) => {
      const principals =
        space.kind === "direct"
          ? store.all<{ principalId: string; displayName: string | null }>(
              `SELECT principal_id AS principalId, display_name AS displayName
               FROM platform_identities
               WHERE agent_profile_id = ? AND platform = ? AND bot_instance_id = ?
                 AND platform_user_id = ? AND paired = 1`,
              space.agentProfileId,
              space.platform,
              space.botInstanceId,
              space.platformConversationId,
            )
          : store.all<{
              principalId: string;
              displayName: string | null;
              role: string;
            }>(
              `SELECT principal_id AS principalId, display_name AS displayName, role
               FROM group_memberships WHERE conversation_space_id = ?
               ORDER BY confirmed_at`,
              space.id,
            );
      return { ...space, principals };
    });
}
