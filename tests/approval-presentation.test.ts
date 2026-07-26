import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalMessage } from "../src/approvals/presentation.js";
import type { ApprovalRequest } from "@imgent/contracts";

const request: ApprovalRequest = {
  requestId: "APR-0123456789ABCDEF01234567",
  toolName: "shell",
  sanitizedInput: {
    command: '/bin/bash -lc "pwd; rg -n \\"QQ|群聊|群\\" README.md | head -80"',
    cwd: "/workspaces/main",
    reason: "读取当前工作区与已有 IMGent 配置，确认如何启用 QQ 群聊。",
    commandActions: [
      {
        type: "unknown",
        command: "pwd; rg -n ...",
      },
    ],
  },
  risk: "high",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

test("approval messages explain the request without dumping transport JSON", () => {
  const message = approvalMessage(request, "zh-CN");

  assert.match(message, /操作：运行终端命令/);
  assert.match(message, /风险：高（需要人工确认，不代表已检测到恶意行为）/);
  assert.match(message, /影响：无法自动确认影响/);
  assert.match(message, /目的：读取当前工作区与已有 IMGent 配置/);
  assert.match(message, /范围：\/workspaces\/main/);
  assert.match(message, /命令预览：\n\/bin\/bash -lc/);
  assert.match(message, /状态：尚未执行/);
  assert.match(message, /允许：\/imgent allow APR-/);
  assert.match(message, /拒绝：\/imgent deny APR-/);
  assert.doesNotMatch(message, /sanitizedInput|commandActions|请求：\s*\{/);
});

test("approval messages have an equivalent readable English presentation", () => {
  const message = approvalMessage(request, "en-US");

  assert.match(message, /Operation: Run a shell command/);
  assert.match(message, /Risk: High \(Requires human review/);
  assert.match(message, /Command preview:/);
  assert.match(message, /Status: not executed/);
  assert.match(message, /Allow: \/imgent allow APR-/);
  assert.doesNotMatch(message, /commandActions/);
});
