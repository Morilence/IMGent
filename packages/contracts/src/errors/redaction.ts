import type { ErrorMessageParam } from "./types.js";

const SENSITIVE_KEYS =
  /token|secret|password|authorization|replyContext|context_token|memoryValue|messageBody|prompt|cause|stack|vendor|raw|response|path|sql|query|statement|body/i;
const SENSITIVE_TEXT =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S+/gi;

export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return value.replaceAll(SENSITIVE_TEXT, "[redacted]");
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEYS.test(key) ? "[redacted]" : redactSensitive(entry, seen),
    ]),
  );
}

export function safeErrorParams(
  params: Record<string, ErrorMessageParam> | undefined,
  allowed: readonly string[] | undefined,
): Record<string, ErrorMessageParam> | undefined {
  if (!params || !allowed?.length) return undefined;
  const filtered = Object.fromEntries(
    allowed.flatMap((key) => {
      const value = params[key];
      if (value === undefined || SENSITIVE_KEYS.test(key)) return [];
      if (typeof value === "string") {
        const redacted = redactSensitive(value);
        if (redacted !== value || value.length > 200) return [];
      }
      return [[key, value]];
    }),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
