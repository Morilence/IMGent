import { createHash } from "node:crypto";

const GROUP_CODE = /^GRP-[A-F0-9]{12}$/u;

export function groupAuthorizationCode(conversationSpaceId: string): string {
  return `GRP-${createHash("sha256")
    .update(conversationSpaceId, "utf8")
    .digest("hex")
    .slice(0, 12)
    .toUpperCase()}`;
}

export function normalizeGroupAuthorizationCode(code: string): string | undefined {
  const normalized = code.trim().toUpperCase();
  return GROUP_CODE.test(normalized) ? normalized : undefined;
}
