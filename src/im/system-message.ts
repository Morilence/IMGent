import type { SupportedLocale } from "@imgent/contracts";

export type SystemMessageStatus =
  | "pairing"
  | "group-authorization"
  | "schedule"
  | "queued"
  | "approval"
  | "question"
  | "error"
  | "system";

const STATUS_LABELS: Record<SystemMessageStatus, Record<SupportedLocale, string>> = {
  pairing: {
    "zh-CN": "配对",
    "en-US": "Pairing",
  },
  "group-authorization": {
    "zh-CN": "群授权",
    "en-US": "Group authorization",
  },
  schedule: {
    "zh-CN": "定时任务",
    "en-US": "Scheduled task",
  },
  queued: {
    "zh-CN": "排队",
    "en-US": "Queued",
  },
  approval: {
    "zh-CN": "审批",
    "en-US": "Approval",
  },
  question: {
    "zh-CN": "询问",
    "en-US": "Question",
  },
  error: {
    "zh-CN": "错误",
    "en-US": "Error",
  },
  system: {
    "zh-CN": "系统",
    "en-US": "System",
  },
};

export function formatSystemMessage(
  status: SystemMessageStatus,
  body: string,
  locale: SupportedLocale,
): string {
  return `[IMGent: ${STATUS_LABELS[status][locale]}]\n${body}`;
}
