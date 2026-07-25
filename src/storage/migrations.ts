export const SCHEMA_VERSION = 7;

export const SCHEMA = `
CREATE TABLE schema_meta (
  version INTEGER NOT NULL
) STRICT;
INSERT INTO schema_meta(version) VALUES (7);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  agent_profile_id TEXT NOT NULL,
  locale TEXT CHECK(locale IN ('zh-CN', 'en-US')),
  workspace TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE platform_identities (
  id TEXT PRIMARY KEY,
  agent_profile_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('qq', 'wechat-ilink')),
  bot_instance_id TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  display_name TEXT,
  paired INTEGER NOT NULL DEFAULT 0 CHECK(paired IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_profile_id, platform, bot_instance_id, platform_user_id)
) STRICT;

CREATE TABLE conversation_spaces (
  id TEXT PRIMARY KEY,
  agent_profile_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('qq', 'wechat-ilink')),
  bot_instance_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('direct', 'group')),
  platform_conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(agent_profile_id, platform, bot_instance_id, kind, platform_conversation_id)
) STRICT;

CREATE TABLE group_memberships (
  conversation_space_id TEXT NOT NULL REFERENCES conversation_spaces(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  platform_member_id TEXT,
  display_name TEXT,
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'unknown')),
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY(conversation_space_id, principal_id)
) STRICT;

CREATE TABLE group_policies (
  conversation_space_id TEXT PRIMARY KEY REFERENCES conversation_spaces(id),
  mode TEXT NOT NULL DEFAULT 'triggered' CHECK(mode IN ('triggered', 'full')),
  platform_full_capability INTEGER NOT NULL DEFAULT 0 CHECK(platform_full_capability IN (0, 1)),
  changed_by_principal_id TEXT REFERENCES principals(id),
  changed_at TEXT NOT NULL
) STRICT;

CREATE TABLE group_authorizations (
  conversation_space_id TEXT PRIMARY KEY REFERENCES conversation_spaces(id),
  authorized_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE inbound_events (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  bot_instance_id TEXT NOT NULL,
  event_id TEXT,
  message_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  sequence TEXT,
  conversation_space_id TEXT NOT NULL REFERENCES conversation_spaces(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  message_json TEXT NOT NULL,
  reply_context_cipher BLOB,
  received_at TEXT NOT NULL,
  raw_expires_at TEXT,
  UNIQUE(bot_instance_id, dedupe_key)
) STRICT;

CREATE INDEX inbound_events_expiry_idx ON inbound_events(raw_expires_at)
  WHERE raw_expires_at IS NOT NULL;

CREATE TABLE transport_checkpoints (
  bot_instance_id TEXT NOT NULL,
  checkpoint_key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(bot_instance_id, checkpoint_key)
) STRICT;

CREATE TABLE agent_sessions (
  conversation_key TEXT PRIMARY KEY,
  driver TEXT NOT NULL CHECK(driver IN ('codex', 'claude-code')),
  session_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  conversation_space_id TEXT NOT NULL REFERENCES conversation_spaces(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  agent_profile_id TEXT NOT NULL,
  schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('once', 'cron')),
  schedule_expression TEXT NOT NULL,
  timezone TEXT,
  context_mode TEXT NOT NULL CHECK(context_mode IN ('fresh', 'series')),
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'blocked')),
  next_run_at TEXT,
  skipped_run_count INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (schedule_kind = 'once' AND timezone IS NULL)
    OR (schedule_kind = 'cron' AND timezone IS NOT NULL)
  )
) STRICT;

CREATE INDEX schedules_due_idx ON schedules(next_run_at, created_at)
  WHERE status = 'active' AND next_run_at IS NOT NULL;

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  UNIQUE(schedule_id, scheduled_for)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  inbound_event_id TEXT REFERENCES inbound_events(id),
  schedule_run_id TEXT UNIQUE REFERENCES schedule_runs(id),
  agent_profile_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  conversation_space_id TEXT NOT NULL REFERENCES conversation_spaces(id),
  conversation_key TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  session_key TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  message_json TEXT NOT NULL,
  reply_context_cipher BLOB,
  curate_memory INTEGER NOT NULL DEFAULT 1 CHECK(curate_memory IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'active', 'retry_wait', 'waiting_approval',
    'succeeded', 'cancelled', 'failed', 'dead_letter'
  )),
  attempt INTEGER NOT NULL DEFAULT 0,
  dangerous_side_effect_started INTEGER NOT NULL DEFAULT 0 CHECK(dangerous_side_effect_started IN (0, 1)),
  final_text TEXT,
  error_json TEXT,
  incident_id TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (inbound_event_id IS NOT NULL AND schedule_run_id IS NULL)
    OR (inbound_event_id IS NULL AND schedule_run_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX tasks_fifo_idx ON tasks(execution_key, status, created_at);
CREATE INDEX tasks_claim_idx ON tasks(created_at, next_attempt_at)
  WHERE status IN ('queued', 'retry_wait');
CREATE INDEX tasks_recent_context_idx ON tasks(
  agent_profile_id, conversation_space_id, conversation_key, created_at DESC
) WHERE inbound_event_id IS NOT NULL;

CREATE TABLE approvals (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  conversation_key TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  tool_name TEXT NOT NULL,
  sanitized_input TEXT NOT NULL,
  risk TEXT NOT NULL CHECK(risk IN ('low', 'medium', 'high')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'allowed', 'denied', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decision_json TEXT
) STRICT;

CREATE INDEX approvals_pending_idx ON approvals(status, expires_at);

CREATE TABLE memory_records (
  id TEXT PRIMARY KEY,
  agent_profile_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK(scope_type IN (
    'personal_private', 'private_episode', 'group_shared', 'group_member', 'group_episode'
  )),
  principal_id TEXT REFERENCES principals(id),
  conversation_space_id TEXT REFERENCES conversation_spaces(id),
  source_conversation_key TEXT NOT NULL,
  source_message_ids TEXT NOT NULL,
  source_task_id TEXT REFERENCES tasks(id),
  origin TEXT NOT NULL CHECK(origin IN ('explicit', 'curated')),
  kind TEXT NOT NULL CHECK(kind IN ('fact', 'preference', 'decision', 'plan', 'episode')),
  fact_key TEXT,
  value TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'forgotten')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE UNIQUE INDEX memory_active_fact_idx
  ON memory_records(
    agent_profile_id,
    scope_type,
    COALESCE(principal_id, ''),
    COALESCE(conversation_space_id, ''),
    CASE WHEN scope_type = 'private_episode' THEN source_conversation_key ELSE '' END,
    fact_key
  )
  WHERE status = 'active' AND fact_key IS NOT NULL;

CREATE INDEX memory_scope_idx ON memory_records(
  agent_profile_id, scope_type, principal_id, conversation_space_id, status
);

CREATE UNIQUE INDEX memory_active_value_idx
  ON memory_records(
    agent_profile_id,
    scope_type,
    COALESCE(principal_id, ''),
    COALESCE(conversation_space_id, ''),
    CASE WHEN scope_type = 'private_episode' THEN source_conversation_key ELSE '' END,
    value
  )
  WHERE status = 'active';

CREATE UNIQUE INDEX memory_source_task_fact_idx
  ON memory_records(
    source_task_id,
    scope_type,
    COALESCE(principal_id, ''),
    COALESCE(conversation_space_id, ''),
    CASE WHEN scope_type = 'private_episode' THEN source_conversation_key ELSE '' END,
    fact_key
  )
  WHERE source_task_id IS NOT NULL AND fact_key IS NOT NULL;

CREATE INDEX memory_audit_idx ON memory_records(updated_at DESC, id DESC);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  memory_id UNINDEXED,
  search_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE memory_outbox (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'processing', 'retry_wait', 'succeeded', 'dead_letter'
  )),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX memory_outbox_claim_idx
  ON memory_outbox(created_at, next_attempt_at)
  WHERE status IN ('pending', 'retry_wait') AND attempt < 3;

CREATE TABLE outbound_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  bot_instance_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'sending', 'retry_wait', 'sent', 'dead_letter'
  )),
  payload_json TEXT NOT NULL,
  reply_context_cipher BLOB,
  platform_message_id TEXT,
  send_mode TEXT CHECK(send_mode IN ('reply', 'proactive')),
  attempt INTEGER NOT NULL DEFAULT 0,
  last_error_json TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX outbound_claim_idx
  ON outbound_messages(created_at, next_attempt_at)
  WHERE status IN ('pending', 'retry_wait') AND attempt < 3;

CREATE TABLE dead_letters (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  bot_instance_id TEXT,
  reference_id TEXT,
  error_json TEXT NOT NULL,
  diagnostic_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  platform_identity_id TEXT NOT NULL REFERENCES platform_identities(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;

CREATE TABLE binding_codes (
  code_hash TEXT PRIMARY KEY,
  source_platform_identity_id TEXT NOT NULL REFERENCES platform_identities(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  agent_profile_id TEXT,
  principal_id TEXT,
  conversation_space_id TEXT,
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX audit_created_idx ON audit_events(created_at);
`;
