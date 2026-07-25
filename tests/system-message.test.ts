import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSystemMessage, type SystemMessageStatus } from "../src/im/system-message.js";

test("IMGent system statuses use one punctuation format in Chinese and English", () => {
  const labels: Array<[SystemMessageStatus, string, string]> = [
    ["pairing", "配对", "Pairing"],
    ["group-authorization", "群授权", "Group authorization"],
    ["queued", "排队", "Queued"],
    ["approval", "审批", "Approval"],
    ["question", "询问", "Question"],
    ["error", "错误", "Error"],
    ["system", "系统", "System"],
  ];
  for (const [status, zh, en] of labels) {
    assert.equal(formatSystemMessage(status, "正文", "zh-CN"), `[IMGent: ${zh}]\n正文`);
    assert.equal(formatSystemMessage(status, "Body", "en-US"), `[IMGent: ${en}]\nBody`);
  }
});
