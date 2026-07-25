import {
  ERROR_DEFINITIONS,
  SUPPORTED_LOCALES,
  type ErrorDescriptor,
  type ErrorMessageKey,
  type SupportedLocale,
} from "@imgent/contracts";

export interface RenderedError {
  code: ErrorDescriptor["code"];
  message: string;
  action?: string;
  retry: ErrorDescriptor["retry"];
  incidentId?: string;
}

const zhCN = {
  "error.config_file_unreadable.message": "无法读取 IMGent 配置文件。",
  "error.config_file_unreadable.action": "请确认配置路径存在且当前用户具有读取权限。",
  "error.config_file_invalid.message": "IMGent 配置内容无效，当前操作无法继续。",
  "error.config_file_invalid.action": "请修正配置后运行 imgent doctor 重新检查。",
  "error.config_workspace_invalid.message": "Agent 工作区不存在、不可访问或超出允许范围。",
  "error.config_workspace_invalid.action":
    "请检查 AgentProfile 的 workspace 和 allowedWorkspaceRoots。",
  "error.cli_usage_invalid.message": "命令参数无效。",
  "error.cli_usage_invalid.action": "请使用 --help 查看正确用法。",
  "error.language_unsupported.message": "不支持指定的语言。",
  "error.language_unsupported.action": "请选择 zh-CN 或 en-US。",
  "error.runtime_node_unsupported.message": "当前 Node.js 版本不受 IMGent 支持。",
  "error.runtime_node_unsupported.action": "请升级到 Node.js 24.18.0 或更高版本。",
  "error.runtime_service_not_running.message": "IMGent 服务当前未运行。",
  "error.runtime_service_not_running.action": "请先运行 imgent start。",
  "error.runtime_service_must_stop.message": "该操作要求 IMGent 服务处于停止状态。",
  "error.runtime_service_must_stop.action": "请先停止对应 dataDir 的 imgent start 进程。",
  "error.runtime_control_unreachable.message": "检测到 IMGent 服务端点，但控制面暂时无法访问。",
  "error.runtime_control_unreachable.action": "请检查服务日志；不要在此状态下直接操作 SQLite。",
  "error.runtime_control_protocol_unsupported.message": "CLI 与运行中的 IMGent 控制协议不兼容。",
  "error.runtime_control_protocol_unsupported.action": "请让 CLI 与服务使用相同版本后重试。",
  "error.runtime_instance_conflict.message": "同一 dataDir 已有 IMGent 服务实例运行。",
  "error.runtime_instance_conflict.action": "请使用现有实例，或先将其停止。",
  "error.runtime_instance_mismatch.message": "控制端点属于另一个 IMGent 实例。",
  "error.runtime_instance_mismatch.action": "请检查配置路径、dataDir 和本机运行中的实例。",
  "error.storage_unavailable.message": "IMGent 本地存储当前不可用。",
  "error.storage_unavailable.action": "请检查数据目录、磁盘空间和 SQLite 文件权限。",
  "error.storage_schema_unsupported.message": "当前数据目录使用了不兼容的旧版数据库。",
  "error.storage_schema_unsupported.action": "请改用全新数据目录；IMGent 不会自动迁移旧数据。",
  "error.adapter_auth_required.message": "消息平台认证已失效，机器人当前不可用。",
  "error.adapter_auth_required.action": "请由部署者更新平台凭据后运行 imgent doctor。",
  "error.adapter_permission_denied.message": "消息平台拒绝了当前权限。",
  "error.adapter_permission_denied.action": "请检查机器人权限和事件订阅配置。",
  "error.adapter_session_invalid.message": "消息平台会话已失效，机器人已停止接收消息。",
  "error.adapter_session_invalid.action": "请由部署者重新完成平台授权。",
  "error.adapter_rate_limited.message": "消息平台请求过于频繁，IMGent 将稍后重试。",
  "error.adapter_rate_limited.action": "无需重复提交；若持续发生，请检查平台限额。",
  "error.adapter_request_timeout.message": "消息平台请求超时。",
  "error.adapter_request_timeout.action": "IMGent 将在安全时自动重试。",
  "error.adapter_service_unavailable.message": "消息平台服务暂时不可用。",
  "error.adapter_service_unavailable.action": "IMGent 将稍后重试。",
  "error.adapter_request_rejected.message": "消息平台拒绝了这次请求。",
  "error.adapter_request_rejected.action": "请检查消息内容、机器人配置和平台限制。",
  "error.adapter_reply_context_invalid.message": "当前回复窗口已经失效，消息无法送达。",
  "error.adapter_reply_context_invalid.action": "请重新向机器人发送一条消息后再试。",
  "error.adapter_compatibility_error.message": "收到 IMGent 尚不支持的平台事件。",
  "error.adapter_compatibility_error.action": "事件已安全隔离；请由部署者检查兼容性死信。",
  "error.adapter_connection_failed.message": "与消息平台的连接暂时中断。",
  "error.adapter_connection_failed.action": "IMGent 将自动尝试重新连接。",
  "error.agent_auth_required.message": "本地 Agent 尚未登录，任务无法继续。",
  "error.agent_auth_required.action": "请由部署者登录对应 Agent 后运行 imgent doctor。",
  "error.agent_version_unsupported.message": "本地 Agent 版本与 IMGent 不兼容。",
  "error.agent_version_unsupported.action": "请升级 Agent CLI 后运行 imgent doctor。",
  "error.agent_unavailable.message": "本地 Agent 暂时不可用。",
  "error.agent_unavailable.action": "IMGent 将在确认安全时重试；也可联系部署者检查 Agent。",
  "error.agent_turn_start_failed.message": "任务尚未开始时本地 Agent 连接中断。",
  "error.agent_turn_start_failed.action": "IMGent 将在确认安全时自动重试。",
  "error.agent_turn_failed.message": "本地 Agent 未能完成任务。",
  "error.agent_turn_failed.action": "请稍后重试；若持续发生，请联系部署者检查本机日志。",
  "error.agent_session_mismatch.message": "会话对应的 Agent 或工作区已经变化。",
  "error.agent_session_mismatch.action": "请由部署者重置该会话后再试。",
  "error.driver_protocol_incomplete.message": "本地 Agent 未返回完整的任务终态。",
  "error.driver_protocol_incomplete.action":
    "IMGent 将在确认安全时重试；持续发生时请升级或检查 Agent。",
  "error.profile_or_driver_missing.message": "任务对应的 AgentProfile 或 Driver 不存在。",
  "error.profile_or_driver_missing.action": "请由部署者检查路由和 AgentProfile 配置。",
  "error.task_execution_failed.message": "任务未能完成。",
  "error.task_execution_failed.action": "请稍后重试；若持续发生，请将错误编号提供给部署者。",
  "error.task_retry_exhausted.message": "任务多次重试后仍未完成。",
  "error.task_retry_exhausted.action": "请稍后重新提交，或联系部署者检查错误编号。",
  "error.task_unsafe_replay.message": "任务可能已经产生外部影响，IMGent 未自动重放。",
  "error.task_unsafe_replay.action": "请由部署者确认实际结果后再决定是否重新执行。",
  "error.process_restart_recovery.message": "IMGent 重启后正在恢复未完成任务。",
  "error.process_restart_recovery.action": "无需重复提交，IMGent 会继续处理安全任务。",
  "error.outbound_rate_limited.message": "回复发送过于频繁，IMGent 将稍后重试。",
  "error.outbound_rate_limited.action": "无需重复提交。",
  "error.outbound_context_expired.message": "回复窗口已过期，最终结果暂时无法送达。",
  "error.outbound_context_expired.action": "请重新向机器人发送消息，或联系部署者查看任务结果。",
  "error.outbound_platform_rejected.message": "消息平台拒绝发送这条回复。",
  "error.outbound_platform_rejected.action": "请联系部署者检查平台限制和死信记录。",
  "error.outbound_send_failed.message": "回复暂时无法发送。",
  "error.outbound_send_failed.action": "IMGent 将自动重试；最终失败会保留在死信中。",
  "error.approval_not_found.message": "审批请求不存在或已经结束。",
  "error.approval_not_found.action": "请使用最新的审批请求。",
  "error.approval_forbidden.message": "当前身份无权处理这项审批。",
  "error.approval_forbidden.action": "请在原会话中由原请求人完成审批。",
  "error.approval_expired.message": "审批请求已过期，原任务没有继续执行。",
  "error.approval_expired.action": "请重新提交任务以生成新的审批请求。",
  "error.identity_operation_rejected.message": "当前身份不能执行这项操作。",
  "error.identity_operation_rejected.action": "请确认配对、会话和管理员权限。",
  "error.memory_operation_rejected.message": "当前会话不能执行这项记忆操作。",
  "error.memory_operation_rejected.action": "请确认记忆存在且属于当前允许的作用域。",
  "error.memory_record_not_found.message": "指定的记忆记录不存在。",
  "error.memory_record_not_found.action": "请使用 imgent memory list 获取有效的记忆 ID。",
  "error.memory_curation_failed.message": "后台记忆整理暂时未完成，不影响本次回复。",
  "error.memory_curation_failed.action": "IMGent 将自动重试，无需重复发送消息。",
  "error.internal_unexpected_error.message": "IMGent 遇到未预期的内部错误。",
  "error.internal_unexpected_error.action": "请将错误编号提供给部署者并查看本机日志。",
} as const satisfies Record<ErrorMessageKey, string>;

const enUS = {
  "error.config_file_unreadable.message": "The IMGent configuration file could not be read.",
  "error.config_file_unreadable.action":
    "Check that the path exists and is readable by the current user.",
  "error.config_file_invalid.message":
    "The IMGent configuration is invalid, so the operation cannot continue.",
  "error.config_file_invalid.action": "Fix the configuration and run imgent doctor again.",
  "error.config_workspace_invalid.message":
    "The agent workspace is missing, inaccessible, or outside the allowed roots.",
  "error.config_workspace_invalid.action":
    "Check the AgentProfile workspace and allowedWorkspaceRoots.",
  "error.cli_usage_invalid.message": "The command arguments are invalid.",
  "error.cli_usage_invalid.action": "Use --help to see the correct syntax.",
  "error.language_unsupported.message": "The requested language is not supported.",
  "error.language_unsupported.action": "Choose zh-CN or en-US.",
  "error.runtime_node_unsupported.message":
    "The current Node.js version is not supported by IMGent.",
  "error.runtime_node_unsupported.action": "Upgrade to Node.js 24.18.0 or newer.",
  "error.runtime_service_not_running.message": "The IMGent service is not running.",
  "error.runtime_service_not_running.action": "Run imgent start first.",
  "error.runtime_service_must_stop.message":
    "This operation requires the IMGent service to be stopped.",
  "error.runtime_service_must_stop.action":
    "Stop the imgent start process for this data directory first.",
  "error.runtime_control_unreachable.message":
    "An IMGent endpoint exists, but its control plane is unreachable.",
  "error.runtime_control_unreachable.action":
    "Inspect the service logs; do not access SQLite directly in this state.",
  "error.runtime_control_protocol_unsupported.message":
    "The CLI and running IMGent control protocol are incompatible.",
  "error.runtime_control_protocol_unsupported.action":
    "Use the same IMGent version for the CLI and service, then retry.",
  "error.runtime_instance_conflict.message":
    "An IMGent service is already running for this data directory.",
  "error.runtime_instance_conflict.action": "Use the existing instance or stop it first.",
  "error.runtime_instance_mismatch.message":
    "The control endpoint belongs to a different IMGent instance.",
  "error.runtime_instance_mismatch.action":
    "Check the configuration path, data directory, and running local instances.",
  "error.storage_unavailable.message": "IMGent local storage is unavailable.",
  "error.storage_unavailable.action":
    "Check the data directory, disk space, and SQLite file permissions.",
  "error.storage_schema_unsupported.message":
    "This data directory uses an incompatible legacy database.",
  "error.storage_schema_unsupported.action":
    "Use a fresh data directory; IMGent does not migrate legacy data.",
  "error.adapter_auth_required.message":
    "Messaging platform authentication has expired, so the bot is unavailable.",
  "error.adapter_auth_required.action": "Update the platform credentials and run imgent doctor.",
  "error.adapter_permission_denied.message":
    "The messaging platform denied the required permission.",
  "error.adapter_permission_denied.action":
    "Check the bot permissions and event subscription settings.",
  "error.adapter_session_invalid.message":
    "The messaging platform session has expired, so the bot stopped receiving messages.",
  "error.adapter_session_invalid.action": "Ask the operator to authorize the platform again.",
  "error.adapter_rate_limited.message":
    "The messaging platform is rate limiting requests. IMGent will retry later.",
  "error.adapter_rate_limited.action":
    "Do not submit the request again; check platform quotas if it continues.",
  "error.adapter_request_timeout.message": "The messaging platform request timed out.",
  "error.adapter_request_timeout.action": "IMGent will retry automatically when it is safe.",
  "error.adapter_service_unavailable.message": "The messaging platform is temporarily unavailable.",
  "error.adapter_service_unavailable.action": "IMGent will retry later.",
  "error.adapter_request_rejected.message": "The messaging platform rejected the request.",
  "error.adapter_request_rejected.action":
    "Check the message, bot configuration, and platform limits.",
  "error.adapter_reply_context_invalid.message":
    "The reply window has expired, so the message cannot be delivered.",
  "error.adapter_reply_context_invalid.action": "Send the bot a new message and try again.",
  "error.adapter_compatibility_error.message": "IMGent received an unsupported platform event.",
  "error.adapter_compatibility_error.action":
    "The event was isolated safely; ask the operator to inspect compatibility dead letters.",
  "error.adapter_connection_failed.message":
    "The connection to the messaging platform was interrupted.",
  "error.adapter_connection_failed.action": "IMGent will reconnect automatically.",
  "error.agent_auth_required.message":
    "The local agent is not signed in, so the task cannot continue.",
  "error.agent_auth_required.action": "Ask the operator to sign in and run imgent doctor.",
  "error.agent_version_unsupported.message":
    "The local agent version is not compatible with IMGent.",
  "error.agent_version_unsupported.action": "Upgrade the agent CLI and run imgent doctor.",
  "error.agent_unavailable.message": "The local agent is temporarily unavailable.",
  "error.agent_unavailable.action":
    "IMGent will retry when safe; the operator can also inspect the agent.",
  "error.agent_turn_start_failed.message": "The local agent disconnected before the task started.",
  "error.agent_turn_start_failed.action": "IMGent will retry automatically when it is safe.",
  "error.agent_turn_failed.message": "The local agent could not complete the task.",
  "error.agent_turn_failed.action":
    "Try again later; if it continues, ask the operator to inspect local logs.",
  "error.agent_session_mismatch.message":
    "The agent or workspace associated with this session has changed.",
  "error.agent_session_mismatch.action": "Ask the operator to reset the session and try again.",
  "error.driver_protocol_incomplete.message":
    "The local agent did not return a complete terminal result.",
  "error.driver_protocol_incomplete.action":
    "IMGent will retry when safe; upgrade or inspect the agent if it continues.",
  "error.profile_or_driver_missing.message":
    "The AgentProfile or Driver for this task does not exist.",
  "error.profile_or_driver_missing.action":
    "Ask the operator to check routes and AgentProfile configuration.",
  "error.task_execution_failed.message": "The task could not be completed.",
  "error.task_execution_failed.action":
    "Try again later; provide the error reference to the operator if it continues.",
  "error.task_retry_exhausted.message": "The task still failed after multiple attempts.",
  "error.task_retry_exhausted.action":
    "Submit it again later or ask the operator to inspect the error reference.",
  "error.task_unsafe_replay.message":
    "The task may already have caused an external effect, so IMGent did not replay it.",
  "error.task_unsafe_replay.action":
    "Ask the operator to verify the actual result before running it again.",
  "error.process_restart_recovery.message":
    "IMGent is recovering an unfinished task after a restart.",
  "error.process_restart_recovery.action":
    "Do not submit it again; IMGent will continue work that is safe to resume.",
  "error.outbound_rate_limited.message": "Replies are being rate limited. IMGent will retry later.",
  "error.outbound_rate_limited.action": "Do not submit the request again.",
  "error.outbound_context_expired.message":
    "The reply window expired, so the final result could not be delivered.",
  "error.outbound_context_expired.action":
    "Send the bot a new message or ask the operator to inspect the task result.",
  "error.outbound_platform_rejected.message": "The messaging platform rejected this reply.",
  "error.outbound_platform_rejected.action":
    "Ask the operator to inspect platform limits and dead letters.",
  "error.outbound_send_failed.message": "The reply could not be sent yet.",
  "error.outbound_send_failed.action":
    "IMGent will retry automatically and retain a dead letter if delivery ultimately fails.",
  "error.approval_not_found.message": "The approval request does not exist or has already ended.",
  "error.approval_not_found.action": "Use the latest approval request.",
  "error.approval_forbidden.message": "This identity cannot answer the approval request.",
  "error.approval_forbidden.action":
    "The original requester must answer in the original conversation.",
  "error.approval_expired.message": "The approval expired, so the original task did not continue.",
  "error.approval_expired.action": "Submit the task again to create a new approval request.",
  "error.identity_operation_rejected.message":
    "This identity cannot perform the requested operation.",
  "error.identity_operation_rejected.action":
    "Check pairing, conversation, and administrator permissions.",
  "error.memory_operation_rejected.message":
    "This conversation cannot perform the requested memory operation.",
  "error.memory_operation_rejected.action":
    "Check that the memory exists and belongs to an allowed scope.",
  "error.memory_record_not_found.message": "The requested memory record does not exist.",
  "error.memory_record_not_found.action": "Use imgent memory list to find a valid memory ID.",
  "error.memory_curation_failed.message":
    "Background memory curation is incomplete, but the current reply is unaffected.",
  "error.memory_curation_failed.action":
    "IMGent will retry automatically; do not resend the message.",
  "error.internal_unexpected_error.message": "IMGent encountered an unexpected internal error.",
  "error.internal_unexpected_error.action":
    "Give the error reference to the operator and inspect local logs.",
} as const satisfies Record<ErrorMessageKey, string>;

export const MESSAGE_CATALOGS: Record<SupportedLocale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

export function normalizeLocale(value: string | undefined): SupportedLocale | undefined {
  if (!value) return undefined;
  const candidates = value
    .split(",")
    .map((entry, index) => {
      const [locale, ...parameters] = entry.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim().match(/^q=([01](?:\.\d+)?)$/i)?.[1])
        .find(Boolean);
      return {
        locale: locale?.replaceAll("_", "-").split(".")[0]?.toLowerCase(),
        quality: quality === undefined ? 1 : Number(quality),
        index,
      };
    })
    .filter((candidate) => candidate.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);
  for (const candidate of candidates) {
    const normalized = candidate.locale;
    if (
      normalized === "zh" ||
      normalized?.startsWith("zh-cn") ||
      normalized?.startsWith("zh-hans")
    ) {
      return "zh-CN";
    }
    if (normalized === "en" || normalized?.startsWith("en-")) {
      return "en-US";
    }
  }
  return undefined;
}

export function resolveLocale(
  candidates: readonly (string | undefined)[],
  fallback: SupportedLocale = "zh-CN",
): SupportedLocale {
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return fallback;
}

function format(key: ErrorMessageKey, locale: SupportedLocale): string {
  return MESSAGE_CATALOGS[locale][key] ?? MESSAGE_CATALOGS["zh-CN"][key] ?? key;
}

export function renderError(descriptor: ErrorDescriptor, locale: SupportedLocale): RenderedError {
  return {
    code: descriptor.code,
    message: format(descriptor.messageKey, locale),
    ...(descriptor.actionKey ? { action: format(descriptor.actionKey, locale) } : {}),
    retry: descriptor.retry,
    ...(descriptor.incidentId ? { incidentId: descriptor.incidentId } : {}),
  };
}

export function renderErrorText(descriptor: ErrorDescriptor, locale: SupportedLocale): string {
  const rendered = renderError(descriptor, locale);
  return [
    rendered.message,
    rendered.action,
    rendered.incidentId
      ? `${locale === "zh-CN" ? "错误编号" : "Error reference"}: ${rendered.incidentId}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function validateMessageCatalogs(): string[] {
  const expected = new Set<string>();
  for (const definition of Object.values(ERROR_DEFINITIONS)) {
    expected.add(definition.messageKey);
    if (definition.actionKey) expected.add(definition.actionKey);
  }
  const errors: string[] = [];
  for (const locale of SUPPORTED_LOCALES) {
    const actual = new Set(Object.keys(MESSAGE_CATALOGS[locale]));
    for (const key of expected) {
      if (!actual.has(key)) errors.push(`${locale} missing ${key}`);
    }
    for (const key of actual) {
      if (!expected.has(key)) errors.push(`${locale} has extra ${key}`);
    }
    for (const [key, template] of Object.entries(MESSAGE_CATALOGS[locale])) {
      if (template.includes("{")) errors.push(`${locale} has unsupported placeholder in ${key}`);
    }
  }
  return errors;
}
