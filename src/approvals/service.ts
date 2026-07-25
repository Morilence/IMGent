import { randomUUID } from "node:crypto";
import { IMGentError } from "@imgent/contracts";
import type { IMGentStore } from "../storage/store.js";
import type { AgentRequestAnswer, ApprovalRequest, OutboundMessage } from "@imgent/contracts";

function now(): string {
  return new Date().toISOString();
}

export interface ApprovalDecision {
  requestId: string;
  status: "allowed" | "denied" | "expired";
  taskId: string;
  answer: AgentRequestAnswer;
  changed: boolean;
}

export interface ApprovalInspection {
  requestId: string;
  status: "pending" | "allowed" | "denied" | "expired";
  taskId: string;
  answer: AgentRequestAnswer;
  expired: boolean;
}

export class ApprovalService {
  constructor(private readonly store: IMGentStore) {}

  create(
    taskId: string,
    conversationKey: string,
    principalId: string,
    request: ApprovalRequest,
    outbound?: OutboundMessage,
  ): void {
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO approvals(
          request_id, task_id, conversation_key, principal_id,
          tool_name, sanitized_input, risk, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(request_id) DO NOTHING`,
        request.requestId,
        taskId,
        conversationKey,
        principalId,
        request.toolName,
        JSON.stringify(request.sanitizedInput),
        request.risk,
        now(),
        request.expiresAt,
      );
      this.store.transitionTask(taskId, ["active"], "waiting_approval");
      if (outbound) this.store.enqueueOutbound(outbound, taskId);
    });
  }

  decide(
    requestId: string,
    principalId: string,
    answer: AgentRequestAnswer,
    conversationKey?: string,
  ): ApprovalDecision {
    return this.store.transaction(() => {
      const approval = this.store.get<{
        task_id: string;
        principal_id: string;
        conversation_key: string;
        status: "pending" | "allowed" | "denied" | "expired";
        expires_at: string;
        decision_json: string | null;
      }>(
        `SELECT task_id, principal_id, conversation_key, status, expires_at, decision_json
         FROM approvals WHERE request_id = ?`,
        requestId,
      );
      if (!approval) throw new IMGentError("APPROVAL_NOT_FOUND");
      if (approval.principal_id !== principalId) {
        throw new IMGentError("APPROVAL_FORBIDDEN");
      }
      if (conversationKey && approval.conversation_key !== conversationKey) {
        throw new IMGentError("APPROVAL_FORBIDDEN");
      }
      if (approval.status !== "pending") {
        return {
          requestId,
          status: approval.status,
          taskId: approval.task_id,
          answer: approval.decision_json
            ? (JSON.parse(approval.decision_json) as AgentRequestAnswer)
            : answer,
          changed: false,
        };
      }
      const expired = approval.expires_at <= now();
      const status = expired ? "expired" : answer.decision === "deny" ? "denied" : "allowed";
      this.store.run(
        `UPDATE approvals SET status = ?, decided_at = ?, decision_json = ?
         WHERE request_id = ? AND status = 'pending'`,
        status,
        now(),
        JSON.stringify(answer),
        requestId,
      );
      if (status === "expired") {
        this.store.transitionTask(approval.task_id, ["waiting_approval"], "failed", {
          error: new IMGentError("APPROVAL_EXPIRED").descriptor,
        });
      } else {
        this.store.transitionTask(approval.task_id, ["waiting_approval"], "active");
      }
      return {
        requestId,
        status,
        taskId: approval.task_id,
        answer,
        changed: true,
      };
    });
  }

  inspect(
    requestId: string,
    principalId: string,
    answer: AgentRequestAnswer,
    conversationKey?: string,
  ): ApprovalInspection {
    const approval = this.store.get<{
      task_id: string;
      principal_id: string;
      conversation_key: string;
      status: "pending" | "allowed" | "denied" | "expired";
      expires_at: string;
      decision_json: string | null;
    }>(
      `SELECT task_id, principal_id, conversation_key, status, expires_at, decision_json
       FROM approvals WHERE request_id = ?`,
      requestId,
    );
    if (!approval) throw new IMGentError("APPROVAL_NOT_FOUND");
    if (
      approval.principal_id !== principalId ||
      (conversationKey && approval.conversation_key !== conversationKey)
    ) {
      throw new IMGentError("APPROVAL_FORBIDDEN");
    }
    return {
      requestId,
      status: approval.status,
      taskId: approval.task_id,
      answer: approval.decision_json
        ? (JSON.parse(approval.decision_json) as AgentRequestAnswer)
        : answer,
      expired: approval.status === "pending" && approval.expires_at <= now(),
    };
  }

  expirePending(): number {
    return this.store.transaction(() => {
      const pending = this.store.all<{ request_id: string; task_id: string }>(
        `SELECT request_id, task_id FROM approvals
         WHERE status = 'pending' AND expires_at <= ?`,
        now(),
      );
      for (const approval of pending) {
        this.store.run(
          `UPDATE approvals SET status = 'expired', decided_at = ? WHERE request_id = ?`,
          now(),
          approval.request_id,
        );
        this.store.transitionTask(approval.task_id, ["waiting_approval"], "failed", {
          error: new IMGentError("APPROVAL_EXPIRED").descriptor,
        });
      }
      return pending.length;
    });
  }

  requestCode(_requestId: string): string {
    return randomUUID().slice(0, 8).toUpperCase();
  }
}
