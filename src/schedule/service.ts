import { randomUUID } from "node:crypto";
import { conversationKey, IMGentError } from "@imgent/contracts";
import { Cron } from "croner";
import { z } from "zod";
import { Logger } from "../runtime/logger.js";
import type { IMGentStore } from "../storage/store.js";
import type { ImAdapter, InboundMessage } from "@imgent/contracts";

export type ScheduleStatus = "active" | "paused" | "completed" | "blocked";

const scheduleContextModeSchema = z.enum(["fresh", "series"]);
export type ScheduleContextMode = z.infer<typeof scheduleContextModeSchema>;

const scheduleFields = {
  name: z.string().min(1),
  prompt: z.string().min(1),
  contextMode: scheduleContextModeSchema.optional(),
  at: z.string().min(1).optional(),
  cron: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
} as const;

export const createScheduleInputSchema = z
  .object({
    ...scheduleFields,
    conversationSpaceId: z.string().min(1),
    principalId: z.string().min(1).optional(),
  })
  .strict();

export const updateScheduleInputSchema = z
  .object({
    name: scheduleFields.name.optional(),
    prompt: scheduleFields.prompt.optional(),
    contextMode: scheduleFields.contextMode,
    at: scheduleFields.at,
    cron: scheduleFields.cron,
    timezone: scheduleFields.timezone,
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0);

export type CreateScheduleInput = z.infer<typeof createScheduleInputSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleInputSchema>;

export function parseCreateScheduleInput(value: unknown): CreateScheduleInput {
  return parseInput(createScheduleInputSchema, value);
}

export function parseUpdateScheduleInput(value: unknown): UpdateScheduleInput {
  return parseInput(updateScheduleInputSchema, value);
}

export interface StoredSchedule {
  id: string;
  name: string;
  prompt: string;
  conversationSpaceId: string;
  principalId: string;
  agentProfileId: string;
  scheduleKind: "once" | "cron";
  scheduleExpression: string;
  timezone?: string;
  contextMode: ScheduleContextMode;
  status: ScheduleStatus;
  nextRunAt?: string;
  skippedRunCount: number;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRow {
  id: string;
  name: string;
  prompt: string;
  conversation_space_id: string;
  principal_id: string;
  agent_profile_id: string;
  schedule_kind: "once" | "cron";
  schedule_expression: string;
  timezone: string | null;
  context_mode: ScheduleContextMode;
  status: ScheduleStatus;
  next_run_at: string | null;
  skipped_run_count: number;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationSpace {
  id: string;
  agent_profile_id: string;
  platform: "qq" | "wechat-ilink";
  bot_instance_id: string;
  kind: "direct" | "group";
  platform_conversation_id: string;
}

function now(): string {
  return new Date().toISOString();
}

function scheduleId(): string {
  return `schedule_${randomUUID()}`;
}

function rowId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function validateText(value: string, maximum: number): string {
  const text = value.trim();
  if (!text || text.length > maximum) throw new IMGentError("CLI_USAGE_INVALID");
  return text;
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  throw new IMGentError("CLI_USAGE_INVALID", {
    ...(field === undefined ? {} : { diagnostic: { field: String(field) } }),
  });
}

function validateTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch (error) {
    throw new IMGentError("CLI_USAGE_INVALID", { cause: error });
  }
}

function parseSchedule(
  input: Pick<CreateScheduleInput, "at" | "cron" | "timezone">,
  reference = new Date(),
): {
  kind: "once" | "cron";
  expression: string;
  timezone?: string;
  nextRunAt: string;
} {
  if (Boolean(input.at) === Boolean(input.cron)) throw new IMGentError("CLI_USAGE_INVALID");
  if (input.at) {
    if (input.timezone) throw new IMGentError("CLI_USAGE_INVALID");
    if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(input.at)) {
      throw new IMGentError("CLI_USAGE_INVALID");
    }
    const date = new Date(input.at);
    if (Number.isNaN(date.valueOf()) || date <= reference) {
      throw new IMGentError("CLI_USAGE_INVALID");
    }
    return { kind: "once", expression: input.at, nextRunAt: date.toISOString() };
  }
  const expression = input.cron!.trim();
  if (expression.split(/\s+/u).length !== 5) throw new IMGentError("CLI_USAGE_INVALID");
  const timezone = validateTimezone(
    input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  let next: Date | null;
  try {
    next = new Cron(expression, { timezone, paused: true }).nextRun(reference);
  } catch (error) {
    throw new IMGentError("CLI_USAGE_INVALID", { cause: error });
  }
  if (!next) throw new IMGentError("CLI_USAGE_INVALID");
  return {
    kind: "cron",
    expression,
    timezone,
    nextRunAt: next.toISOString(),
  };
}

export class ScheduleService {
  constructor(
    private readonly store: IMGentStore,
    private readonly adapters: ReadonlyMap<string, ImAdapter>,
    private readonly profileIds?: ReadonlySet<string>,
    private readonly routes?: ReadonlyMap<string, string>,
  ) {}

  create(input: CreateScheduleInput): StoredSchedule {
    const name = validateText(input.name, 120);
    const prompt = validateText(input.prompt, 32_000);
    const contextMode = input.contextMode ?? "fresh";
    if (contextMode !== "fresh" && contextMode !== "series") {
      throw new IMGentError("CLI_USAGE_INVALID");
    }
    const space = this.requireSpace(input.conversationSpaceId);
    this.requireExecutable(space);
    const principalId = this.resolvePrincipal(space, input.principalId);
    const schedule = parseSchedule(input);
    const id = scheduleId();
    const timestamp = now();
    this.store.run(
      `INSERT INTO schedules(
        id, name, prompt, conversation_space_id, principal_id, agent_profile_id,
        schedule_kind, schedule_expression, timezone, context_mode, status,
        next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      id,
      name,
      prompt,
      space.id,
      principalId,
      space.agent_profile_id,
      schedule.kind,
      schedule.expression,
      schedule.timezone ?? null,
      contextMode,
      schedule.nextRunAt,
      timestamp,
      timestamp,
    );
    this.audit("schedule.created", this.require(id));
    return this.require(id);
  }

  list(): StoredSchedule[] {
    return this.store
      .all<ScheduleRow>("SELECT * FROM schedules WHERE removed_at IS NULL ORDER BY created_at")
      .map(storedSchedule);
  }

  get(id: string): StoredSchedule | undefined {
    const row = this.store.get<ScheduleRow>(
      "SELECT * FROM schedules WHERE id = ? AND removed_at IS NULL",
      id,
    );
    return row ? storedSchedule(row) : undefined;
  }

  require(id: string): StoredSchedule {
    const schedule = this.get(id);
    if (!schedule) throw new IMGentError("CLI_USAGE_INVALID");
    return schedule;
  }

  update(id: string, input: UpdateScheduleInput): StoredSchedule {
    const current = this.require(id);
    const hasTiming = input.at !== undefined || input.cron !== undefined;
    if (input.timezone !== undefined && current.scheduleKind !== "cron" && !input.cron) {
      throw new IMGentError("CLI_USAGE_INVALID");
    }
    const parsed = hasTiming
      ? parseSchedule(input)
      : input.timezone !== undefined && current.scheduleKind === "cron"
        ? parseSchedule({ cron: current.scheduleExpression, timezone: input.timezone })
        : undefined;
    const name = input.name === undefined ? current.name : validateText(input.name, 120);
    const prompt = input.prompt === undefined ? current.prompt : validateText(input.prompt, 32_000);
    const contextMode = input.contextMode ?? current.contextMode;
    if (contextMode !== "fresh" && contextMode !== "series") {
      throw new IMGentError("CLI_USAGE_INVALID");
    }
    if (parsed) {
      const space = this.requireSpace(current.conversationSpaceId);
      this.requireExecutable(space);
    }
    const timezone = parsed ? (parsed.timezone ?? null) : (current.timezone ?? null);
    this.store.run(
      `UPDATE schedules SET name = ?, prompt = ?, context_mode = ?,
         schedule_kind = ?, schedule_expression = ?, timezone = ?,
         next_run_at = ?, status = ?, blocked_reason = ?, updated_at = ?
       WHERE id = ?`,
      name,
      prompt,
      contextMode,
      parsed?.kind ?? current.scheduleKind,
      parsed?.expression ?? current.scheduleExpression,
      timezone,
      parsed?.nextRunAt ?? current.nextRunAt ?? null,
      parsed ? "active" : current.status,
      parsed ? null : (current.blockedReason ?? null),
      now(),
      id,
    );
    this.audit("schedule.updated", this.require(id));
    return this.require(id);
  }

  setStatus(id: string, status: "active" | "paused"): StoredSchedule {
    const current = this.require(id);
    if (status === "active") {
      const space = this.requireSpace(current.conversationSpaceId);
      this.requireExecutable(space);
      const parsed =
        current.scheduleKind === "once"
          ? parseSchedule({ at: current.scheduleExpression })
          : parseSchedule({
              cron: current.scheduleExpression,
              timezone: current.timezone!,
            });
      this.store.run(
        `UPDATE schedules SET status = 'active', next_run_at = ?,
           blocked_reason = NULL, updated_at = ? WHERE id = ?`,
        parsed.nextRunAt,
        now(),
        id,
      );
    } else {
      this.store.run(
        `UPDATE schedules SET status = 'paused', updated_at = ? WHERE id = ?`,
        now(),
        id,
      );
    }
    this.audit(`schedule.${status === "active" ? "resumed" : "paused"}`, this.require(id));
    return this.require(id);
  }

  remove(id: string): StoredSchedule {
    this.require(id);
    this.store.run(
      `UPDATE schedules SET status = 'paused', next_run_at = NULL,
         removed_at = ?, updated_at = ? WHERE id = ?`,
      now(),
      now(),
      id,
    );
    const removed = { ...this.requireIncludingRemoved(id), status: "paused" as const };
    this.audit("schedule.removed", removed);
    return removed;
  }

  resetContext(id: string): StoredSchedule {
    this.require(id);
    const running =
      this.store.get<{ count: number }>(
        `SELECT count(*) AS count FROM tasks
         WHERE execution_key = ? AND status IN (
           'queued', 'active', 'retry_wait', 'waiting_approval'
         )`,
        `schedule:${id}`,
      )?.count ?? 0;
    if (running > 0) throw new IMGentError("CLI_USAGE_INVALID");
    this.store.run("DELETE FROM agent_sessions WHERE conversation_key = ?", `schedule:${id}`);
    this.audit("schedule.context-reset", this.require(id));
    return this.require(id);
  }

  history(id: string): unknown[] {
    this.requireIncludingRemoved(id);
    return this.store.all(
      `SELECT sr.id AS runId, sr.scheduled_for AS scheduledFor,
              sr.enqueued_at AS enqueuedAt, t.id AS taskId, t.status,
              t.final_text AS finalText, t.error_json AS error,
              om.status AS outboundStatus, om.send_mode AS sendMode
       FROM schedule_runs sr
       LEFT JOIN tasks t ON t.schedule_run_id = sr.id
       LEFT JOIN outbound_messages om
         ON om.task_id = t.id AND om.idempotency_key = (t.id || ':final')
       WHERE sr.schedule_id = ?
       ORDER BY sr.scheduled_for DESC`,
      id,
    );
  }

  trigger(id: string): string {
    const schedule = this.require(id);
    if (schedule.status === "blocked") throw new IMGentError("CLI_USAGE_INVALID");
    const space = this.requireSpace(schedule.conversationSpaceId);
    this.requireExecutable(space);
    const pending =
      this.store.get<{ count: number }>(
        `SELECT count(*) AS count FROM tasks
         WHERE execution_key = ? AND status IN (
           'queued', 'active', 'retry_wait', 'waiting_approval'
         )`,
        `schedule:${id}`,
      )?.count ?? 0;
    if (pending > 0) throw new IMGentError("CLI_USAGE_INVALID");
    const taskId = this.enqueue(schedule, space, now(), true);
    this.audit("schedule.manual-run", schedule);
    return taskId;
  }

  processDue(reference = new Date()): boolean {
    const timestamp = reference.toISOString();
    const due = this.store.get<ScheduleRow>(
      `SELECT * FROM schedules INDEXED BY schedules_due_idx
       WHERE status = 'active' AND next_run_at <= ?
         AND removed_at IS NULL
       ORDER BY next_run_at, created_at LIMIT 1`,
      timestamp,
    );
    if (!due?.next_run_at) return false;
    const schedule = storedSchedule(due);
    const scheduledFor = this.scheduledOccurrence(schedule, reference);
    let space: ConversationSpace;
    try {
      space = this.requireSpace(schedule.conversationSpaceId);
      this.requireExecutable(space);
    } catch (error) {
      this.store.run(
        `UPDATE schedules SET status = 'blocked', blocked_reason = ?,
           next_run_at = NULL, updated_at = ? WHERE id = ?`,
        error instanceof Error ? error.message.slice(0, 500) : "delivery unavailable",
        timestamp,
        schedule.id,
      );
      this.audit("schedule.blocked", { ...schedule, status: "blocked" });
      return true;
    }
    this.store.transaction(() => {
      const active =
        this.store.get<{ count: number }>(
          `SELECT count(*) AS count FROM tasks
           WHERE execution_key = ? AND status IN (
             'queued', 'active', 'retry_wait', 'waiting_approval'
           )`,
          `schedule:${schedule.id}`,
        )?.count ?? 0;
      this.advance(schedule, reference, active > 0);
      if (active === 0) this.enqueue(schedule, space, scheduledFor!, false, false);
    });
    return true;
  }

  private advance(schedule: StoredSchedule, reference: Date, skipped: boolean): void {
    if (schedule.scheduleKind === "once") {
      this.store.run(
        `UPDATE schedules SET status = 'completed', next_run_at = NULL,
           skipped_run_count = skipped_run_count + ?, updated_at = ? WHERE id = ?`,
        skipped ? 1 : 0,
        reference.toISOString(),
        schedule.id,
      );
      return;
    }
    const next = new Cron(schedule.scheduleExpression, {
      timezone: schedule.timezone!,
      paused: true,
    }).nextRun(reference);
    if (!next) {
      this.store.run(
        `UPDATE schedules SET status = 'completed', next_run_at = NULL,
           skipped_run_count = skipped_run_count + ?, updated_at = ? WHERE id = ?`,
        skipped ? 1 : 0,
        reference.toISOString(),
        schedule.id,
      );
      return;
    }
    this.store.run(
      `UPDATE schedules SET next_run_at = ?,
         skipped_run_count = skipped_run_count + ?, updated_at = ? WHERE id = ?`,
      next.toISOString(),
      skipped ? 1 : 0,
      reference.toISOString(),
      schedule.id,
    );
  }

  private enqueue(
    schedule: StoredSchedule,
    space: ConversationSpace,
    scheduledFor: string,
    manual: boolean,
    transactional = true,
  ): string {
    const operation = () => {
      const runId = rowId("schedule_run");
      const taskId = rowId("task");
      const timestamp = now();
      const principalActor = this.principalActor(space, schedule.principalId);
      const message: InboundMessage = {
        messageId: `${manual ? "manual" : "scheduled"}:${schedule.id}:${scheduledFor}`,
        dedupeKey: `${manual ? "manual" : "scheduled"}:${schedule.id}:${scheduledFor}`,
        platform: space.platform,
        botInstanceId: space.bot_instance_id,
        conversation: {
          kind: space.kind,
          platformConversationId: space.platform_conversation_id,
        },
        actor: principalActor,
        parts: [{ type: "text", text: schedule.prompt }],
        mentions: [],
        receivedAt: timestamp,
        triggered: true,
      };
      const interactionKey = conversationKey(schedule.agentProfileId, message);
      this.store.run(
        `INSERT INTO schedule_runs(id, schedule_id, scheduled_for, enqueued_at)
         VALUES (?, ?, ?, ?)`,
        runId,
        schedule.id,
        scheduledFor,
        timestamp,
      );
      this.store.run(
        `INSERT INTO tasks(
          id, schedule_run_id, agent_profile_id, principal_id,
          conversation_space_id, conversation_key, execution_key, session_key,
          idempotency_key, message_json, curate_memory, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'queued', ?, ?)`,
        taskId,
        runId,
        schedule.agentProfileId,
        schedule.principalId,
        schedule.conversationSpaceId,
        interactionKey,
        `schedule:${schedule.id}`,
        schedule.contextMode === "series" ? `schedule:${schedule.id}` : null,
        `schedule:${schedule.id}:${scheduledFor}`,
        JSON.stringify(message),
        timestamp,
        timestamp,
      );
      return taskId;
    };
    return transactional ? this.store.transaction(operation) : operation();
  }

  private scheduledOccurrence(schedule: StoredSchedule, reference: Date): string {
    if (schedule.scheduleKind === "once") return schedule.nextRunAt!;
    const firstDue = new Date(schedule.nextRunAt!);
    const previous = new Cron(schedule.scheduleExpression, {
      timezone: schedule.timezone!,
      paused: true,
    }).previousRuns(1, new Date(reference.valueOf() + 1_000))[0];
    if (!previous || previous < firstDue || previous > reference) return schedule.nextRunAt!;
    return previous.toISOString();
  }

  private requireSpace(id: string): ConversationSpace {
    const row = this.store.get<ConversationSpace>(
      `SELECT id, agent_profile_id, platform, bot_instance_id, kind,
              platform_conversation_id
       FROM conversation_spaces WHERE id = ?`,
      id,
    );
    if (!row) throw new IMGentError("CLI_USAGE_INVALID");
    return row;
  }

  private requireExecutable(space: ConversationSpace): void {
    if (
      (this.profileIds && !this.profileIds.has(space.agent_profile_id)) ||
      (this.routes && this.routes.get(space.bot_instance_id) !== space.agent_profile_id)
    ) {
      throw new IMGentError("PROFILE_OR_DRIVER_MISSING");
    }
    const adapter = this.adapters.get(space.bot_instance_id);
    if (
      !adapter ||
      !adapter.capabilities.supportsProactiveSend ||
      !adapter.capabilities.conversationKinds.includes(space.kind)
    ) {
      throw new IMGentError("OUTBOUND_PLATFORM_REJECTED", {
        diagnostic: {
          botInstanceId: space.bot_instance_id,
          platform: space.platform,
          reason: "proactive send unsupported",
        },
      });
    }
  }

  private requireIncludingRemoved(id: string): StoredSchedule {
    const row = this.store.get<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", id);
    if (!row) throw new IMGentError("CLI_USAGE_INVALID");
    return storedSchedule(row);
  }

  private audit(eventType: string, schedule: StoredSchedule): void {
    this.store.run(
      `INSERT INTO audit_events(
        id, agent_profile_id, principal_id, conversation_space_id,
        event_type, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rowId("audit"),
      schedule.agentProfileId,
      schedule.principalId,
      schedule.conversationSpaceId,
      eventType,
      JSON.stringify({
        scheduleId: schedule.id,
        status: schedule.status,
        scheduleKind: schedule.scheduleKind,
        contextMode: schedule.contextMode,
        nextRunAt: schedule.nextRunAt ?? null,
      }),
      now(),
    );
  }

  private resolvePrincipal(space: ConversationSpace, requested?: string): string {
    if (space.kind === "direct") {
      const principals = this.store.all<{ principal_id: string }>(
        `SELECT principal_id FROM platform_identities
         WHERE agent_profile_id = ? AND platform = ? AND bot_instance_id = ?
           AND platform_user_id = ? AND paired = 1`,
        space.agent_profile_id,
        space.platform,
        space.bot_instance_id,
        space.platform_conversation_id,
      );
      if (principals.length !== 1) throw new IMGentError("IDENTITY_OPERATION_REJECTED");
      if (requested && requested !== principals[0]!.principal_id) {
        throw new IMGentError("IDENTITY_OPERATION_REJECTED");
      }
      return principals[0]!.principal_id;
    }
    if (!requested) throw new IMGentError("CLI_USAGE_INVALID");
    const allowed = this.store.get<{ id: string }>(
      `SELECT gm.principal_id AS id
       FROM group_memberships gm
       JOIN group_authorizations ga
         ON ga.conversation_space_id = gm.conversation_space_id
       WHERE gm.conversation_space_id = ? AND gm.principal_id = ?`,
      space.id,
      requested,
    );
    if (!allowed) throw new IMGentError("IDENTITY_OPERATION_REJECTED");
    return requested;
  }

  private principalActor(space: ConversationSpace, principalId: string): InboundMessage["actor"] {
    if (space.kind === "direct") {
      const identity = this.store.get<{
        platform_user_id: string;
        display_name: string | null;
      }>(
        `SELECT platform_user_id, display_name FROM platform_identities
         WHERE principal_id = ? AND agent_profile_id = ? AND platform = ?
           AND bot_instance_id = ? AND platform_user_id = ?`,
        principalId,
        space.agent_profile_id,
        space.platform,
        space.bot_instance_id,
        space.platform_conversation_id,
      );
      if (!identity) throw new IMGentError("IDENTITY_OPERATION_REJECTED");
      return {
        platformUserId: identity.platform_user_id,
        ...(identity.display_name ? { displayName: identity.display_name } : {}),
      };
    }
    const member = this.store.get<{
      platform_member_id: string | null;
      display_name: string | null;
      role: InboundMessage["actor"]["role"];
    }>(
      `SELECT platform_member_id, display_name, role FROM group_memberships
       WHERE conversation_space_id = ? AND principal_id = ?`,
      space.id,
      principalId,
    );
    if (!member) throw new IMGentError("IDENTITY_OPERATION_REJECTED");
    return {
      platformUserId: member.platform_member_id ?? principalId,
      ...(member.platform_member_id ? { platformMemberId: member.platform_member_id } : {}),
      ...(member.display_name ? { displayName: member.display_name } : {}),
      ...(member.role ? { role: member.role } : {}),
    };
  }
}

function storedSchedule(row: ScheduleRow): StoredSchedule {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    conversationSpaceId: row.conversation_space_id,
    principalId: row.principal_id,
    agentProfileId: row.agent_profile_id,
    scheduleKind: row.schedule_kind,
    scheduleExpression: row.schedule_expression,
    ...(row.timezone ? { timezone: row.timezone } : {}),
    contextMode: row.context_mode,
    status: row.status,
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    skippedRunCount: row.skipped_run_count,
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SchedulePlanner {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly logger = new Logger("schedule-planner");

  constructor(private readonly service: ScheduleService) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), 1_000);
    this.timer.unref();
    this.pump();
  }

  private pump(): void {
    if (this.running) return;
    this.running = true;
    try {
      while (this.service.processDue()) {
        // Drain every due definition before yielding the planner lock.
      }
    } catch (error) {
      this.logger.errorFrom("schedule.pump-failed", error);
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
