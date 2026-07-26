import type { ApprovalRequest, SupportedLocale } from "@imgent/contracts";

const READ_ONLY_ACTIONS = new Set(["read", "search", "list"]);
const WRITE_ACTIONS = new Set([
  "write",
  "create",
  "delete",
  "move",
  "rename",
  "execute",
  "permissions",
]);

function text(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function preview(value: string, limit = 1_200): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function actionTypes(input: Record<string, unknown>): string[] {
  const actions = input.commandActions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const type = (entry as { type?: unknown }).type;
    return typeof type === "string" ? [type] : [];
  });
}

function operation(request: ApprovalRequest, locale: SupportedLocale): string {
  const value = request.toolName.toLowerCase();
  if (value === "shell" || value.includes("bash")) {
    return locale === "zh-CN" ? "运行终端命令" : "Run a shell command";
  }
  if (value === "file-change" || value.includes("write") || value.includes("edit")) {
    return locale === "zh-CN" ? "修改工作区文件" : "Change workspace files";
  }
  if (value === "permissions") {
    return locale === "zh-CN" ? "变更运行权限" : "Change runtime permissions";
  }
  return locale === "zh-CN" ? `使用工具 ${request.toolName}` : `Use tool ${request.toolName}`;
}

function impact(request: ApprovalRequest, locale: SupportedLocale): string {
  const actions = actionTypes(request.sanitizedInput);
  const tool = request.toolName.toLowerCase();
  if (
    (actions.length > 0 && actions.every((action) => READ_ONLY_ACTIONS.has(action))) ||
    tool === "read" ||
    tool === "glob"
  ) {
    return locale === "zh-CN"
      ? "只读；不会按当前请求修改文件"
      : "Read-only; this request does not change files";
  }
  if (
    actions.some((action) => WRITE_ACTIONS.has(action)) ||
    tool === "file-change" ||
    tool.includes("write") ||
    tool.includes("edit")
  ) {
    return locale === "zh-CN"
      ? "可能修改文件、数据或权限"
      : "May change files, data, or permissions";
  }
  return locale === "zh-CN"
    ? "无法自动确认影响，请检查下方预览"
    : "Impact could not be classified; review the preview below";
}

function risk(request: ApprovalRequest, locale: SupportedLocale): string {
  const labels =
    locale === "zh-CN"
      ? { low: "低", medium: "中", high: "高" }
      : { low: "Low", medium: "Medium", high: "High" };
  const explanation =
    request.risk === "high"
      ? locale === "zh-CN"
        ? "需要人工确认，不代表已检测到恶意行为"
        : "Requires human review; this does not mean malicious behavior was detected"
      : locale === "zh-CN"
        ? "仍需由请求人确认业务必要性"
        : "The requester must still confirm the business need";
  return locale === "zh-CN"
    ? `${labels[request.risk]}（${explanation}）`
    : `${labels[request.risk]} (${explanation})`;
}

export function approvalMessage(request: ApprovalRequest, locale: SupportedLocale): string {
  const reason = text(request.sanitizedInput, "reason");
  const cwd = text(request.sanitizedInput, "cwd");
  const command = text(request.sanitizedInput, "command");
  const permissionValue = request.sanitizedInput.permissions;
  const lines =
    locale === "zh-CN"
      ? [
          `操作：${operation(request, locale)}`,
          `风险：${risk(request, locale)}`,
          `影响：${impact(request, locale)}`,
          ...(reason ? [`目的：${preview(reason, 500)}`] : []),
          ...(cwd ? [`范围：${preview(cwd, 500)}`] : []),
          ...(command ? ["命令预览：", preview(command)] : []),
          ...(permissionValue
            ? ["权限预览：", preview(JSON.stringify(permissionValue, null, 2))]
            : []),
          "状态：尚未执行；允许后只处理这一次请求。",
          `审批编号：${request.requestId}`,
          `允许：/imgent allow ${request.requestId}`,
          `拒绝：/imgent deny ${request.requestId}`,
        ]
      : [
          `Operation: ${operation(request, locale)}`,
          `Risk: ${risk(request, locale)}`,
          `Impact: ${impact(request, locale)}`,
          ...(reason ? [`Purpose: ${preview(reason, 500)}`] : []),
          ...(cwd ? [`Scope: ${preview(cwd, 500)}`] : []),
          ...(command ? ["Command preview:", preview(command)] : []),
          ...(permissionValue
            ? ["Permission preview:", preview(JSON.stringify(permissionValue, null, 2))]
            : []),
          "Status: not executed; allowing approves only this request.",
          `Approval ID: ${request.requestId}`,
          `Allow: /imgent allow ${request.requestId}`,
          `Deny: /imgent deny ${request.requestId}`,
        ];
  return lines.join("\n");
}
